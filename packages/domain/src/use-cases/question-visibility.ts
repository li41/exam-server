import type { AuthIdentity } from "@server-foundation/api-contracts";
import type {
  QuestionBankScope,
  QuestionOwnerScope,
} from "../ports/question-bank-repository.js";

/**
 * 「可看全部題目」。與 PHP 逐字同名
 * （`exam.tw/src/Models/CompanyMember.php:44` `PERM_QUESTIONS_ALL = 'questions_all'`）。
 */
export const QUESTIONS_ALL_ROLE = "questions_all";

/**
 * 「只看自己建立的題目」。與 PHP 逐字同名
 * （`exam.tw/src/Models/CompanyMember.php:45` `PERM_QUESTIONS_OWN = 'questions_own'`）。
 */
export const QUESTIONS_OWN_ROLE = "questions_own";

/**
 * 把身分翻成題庫的「可見擁有者」：`null` ＝ 看全部，字串 ＝ 只看這個人建立的。
 *
 * 這是**唯一**一處把角色翻成可見範圍的地方；`QuestionOwnerScope.visibleQuestionOwnerId`
 * 是必填欄位，⇒ 任何新的呼叫端都必須明確決定要傳什麼，
 * ⛔ 不要在個別 route 或 repository 裡各自再判斷一次角色。
 *
 * 對照 PHP `Ajax/Actions.php:226-230` `canOperateQuestion()`
 * ＋ `Models/CompanyMember.php` 的 `canViewAllQuestions()`：
 *
 * | 角色                                    | 院內（本函式）        | PHP                                            |
 * | --------------------------------------- | --------------------- | ---------------------------------------------- |
 * | 有 `questions_all`                      | `null`（看全部）      | `canViewAllQuestions()` 為真 ⇒ 看全部           |
 * | 有 `questions_own`、沒有 `questions_all` | `userId`（只看自己）  | `created_by === 目前使用者`                      |
 * | 兩者都有                                | `null`（看全部）      | 同上，`questions_all` 勝（PHP 畫面把兩者做成互斥） |
 * | 🔴 兩者都沒有                            | `null`（**看全部**）  | ⚠️ **403 完全不能進題庫**                        |
 *
 * 🔴 最後一列是**刻意的登記偏離**，理由是既有帳號：院內今天所有帳號的 `roles`
 * 都不含這兩個值（實測見 `doc/question-bank-owner-scope.md`），
 * 照 PHP 做會讓**所有現存使用者一次全部看不到題目**。
 * ⇒ 主公 2026-08-21 裁示：收窄是**選擇性加上去**的，預設維持今天的行為。
 * ⛔ 不要「為了和 PHP 一致」把預設改成只看自己或 403。
 */
export const visibleQuestionOwnerIdFor = (
  identity: Pick<AuthIdentity, "userId" | "roles">,
): string | null => {
  if (identity.roles.includes(QUESTIONS_ALL_ROLE)) return null;
  if (identity.roles.includes(QUESTIONS_OWN_ROLE)) return identity.userId;
  return null;
};

/**
 * 把一個沒有收窄資訊的 scope 明確地標成「這一次查詢**刻意不收窄**」。
 *
 * 🔴 存在的理由是**可稽核**：`rg "unnarrowedQuestionScope"` 一次就能列出
 * 全 repo 每一個刻意的例外，⛔ 不會有人靠 `visibleQuestionOwnerId: null`
 * 這種看起來很無害的字面值偷偷繞過收窄。
 * ⇒ 新增呼叫點時，**必須**在呼叫處寫下為什麼收窄在那裡會造成傷害。
 *
 * 今天全 repo 的合法例外只有四類（每一處都有就地註解）：
 * 1. 建立後的 read-back：那一列 `created_by` 就是自己，收窄只會讓「建立成功卻讀不回來」。
 * 2. 唯一性檢查（題目 code 在**租戶內**唯一）：收窄會讓匯入看不到別人佔用的 code，
 *    然後撞上資料庫層的 duplicate error ⇒ 訊息更難懂，而且擋不住。
 * 3. 「還有東西在引用它嗎」（檔案／分類）：收窄會讓人**刪掉別人正在用的東西**。
 * 4. question-clusters／question-groups／test-booklets 這幾族**本來就還沒收窄**
 *    （登記在 `doc/question-bank-owner-scope.md`）⇒ 這裡傳 `null` 是維持今天的行為，
 *    ⛔ 不是新開的洞。
 */
export const unnarrowedQuestionScope = (
  scope: QuestionBankScope,
): QuestionOwnerScope => ({ ...scope, visibleQuestionOwnerId: null });
