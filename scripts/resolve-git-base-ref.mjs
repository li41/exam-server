import { spawnSync } from "node:child_process";

const gitResult = (args, cwd, spawnSyncFn) =>
  spawnSyncFn("git", args, { cwd, encoding: "utf8" });

const failureDetail = (result) => {
  const details = [result.error?.message, result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  if (details.length > 0) return details.join(" | ");
  return `exit status ${result.status ?? "unknown"}`;
};

const verifyCommit = (ref, cwd, spawnSyncFn) => {
  const result = gitResult(
    ["rev-parse", "--verify", `${ref}^{commit}`],
    cwd,
    spawnSyncFn,
  );
  if (result.status !== 0) {
    return { resolved: false, reason: failureDetail(result) };
  }
  const commit = result.stdout.trim();
  if (!commit)
    return { resolved: false, reason: `${ref} resolved to empty output` };
  return { resolved: true, commit };
};

export function resolveGitBaseRef({
  envName,
  envValue,
  cwd = process.cwd(),
  remoteRef = "origin/main",
  spawnSyncFn = spawnSync,
}) {
  if (!envName?.trim()) throw new Error("envName is required");

  const explicitRef = envValue?.trim();
  if (explicitRef) {
    const verified = verifyCommit(explicitRef, cwd, spawnSyncFn);
    if (!verified.resolved) {
      throw new Error(
        `Unable to resolve ${envName}=${explicitRef}: ${verified.reason}`,
      );
    }
    return {
      resolved: true,
      ref: explicitRef,
      commit: verified.commit,
      source: "environment",
    };
  }

  const remote = verifyCommit(remoteRef, cwd, spawnSyncFn);
  if (!remote.resolved) {
    return {
      resolved: false,
      reason: `${remoteRef} is unavailable: ${remote.reason}`,
    };
  }

  const mergeBase = gitResult(
    ["merge-base", remoteRef, "HEAD"],
    cwd,
    spawnSyncFn,
  );
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    return {
      resolved: false,
      reason: `git merge-base ${remoteRef} HEAD failed: ${failureDetail(mergeBase)}`,
    };
  }

  const commit = mergeBase.stdout.trim();
  return {
    resolved: true,
    ref: commit,
    commit,
    source: `git merge-base ${remoteRef} HEAD`,
  };
}

export function formatBaseResolution(envName, resolution) {
  if (!resolution.resolved) {
    throw new Error("formatBaseResolution requires a resolved base");
  }
  if (resolution.source === "environment") {
    return `Using ${envName} from environment: ${resolution.ref} -> ${resolution.commit}.`;
  }
  return `${envName} not set; using local base from ${resolution.source}: ${resolution.commit}.`;
}
