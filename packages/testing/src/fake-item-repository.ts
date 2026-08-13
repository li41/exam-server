import type {
  CreateItemInput,
  Item,
  ItemListQuery,
  Page,
  UpdateItemInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type { ItemRepository, ItemScope } from "@server-foundation/domain";

const encodeCursor = (offset: number) => btoa(String(offset));

const decodeCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  try {
    const offset = Number.parseInt(atob(cursor), 10);
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch {
    // Fall through to the domain error below.
  }
  throw new InvalidCursorError();
};

export class InMemoryItemRepository implements ItemRepository {
  private readonly items: Item[] = [];
  private nextId = 1;

  async list(query: ItemListQuery, scope: ItemScope): Promise<Page<Item>> {
    const search = query.search?.toLocaleLowerCase();
    const visible = this.items.filter((item) => {
      if (item.deletedAt || item.tenantId !== scope.tenantId) return false;
      return !search || item.title.toLocaleLowerCase().includes(search);
    });
    const offset = decodeCursor(query.cursor);
    const items = visible.slice(offset, offset + query.limit);
    const nextOffset = offset + items.length;

    return {
      items,
      page: {
        nextCursor:
          nextOffset < visible.length ? encodeCursor(nextOffset) : null,
      },
    };
  }

  async get(id: string, scope: ItemScope): Promise<Item | null> {
    return (
      this.items.find(
        (item) =>
          item.id === id && item.tenantId === scope.tenantId && !item.deletedAt,
      ) ?? null
    );
  }

  async create(input: CreateItemInput, scope: ItemScope): Promise<Item> {
    const now = new Date().toISOString();
    const item: Item = {
      id: `item-${this.nextId++}`,
      tenantId: scope.tenantId,
      title: input.title,
      status: "draft",
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.items.unshift(item);
    return item;
  }

  async update(
    id: string,
    input: UpdateItemInput,
    scope: ItemScope,
  ): Promise<Item> {
    const item = this.items.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    if (!item) throw new NotFoundError("item", id);
    if (item.version !== input.version) {
      throw new ConflictError(
        `Item ${id} has changed; reload before updating.`,
      );
    }

    item.title = input.title;
    item.version += 1;
    item.updatedAt = new Date().toISOString();
    return item;
  }

  async softDelete(
    id: string,
    version: number,
    scope: ItemScope,
  ): Promise<void> {
    const item = this.items.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    if (!item) throw new NotFoundError("item", id);
    if (item.version !== version) {
      throw new ConflictError(
        `Item ${id} has changed; reload before deleting.`,
      );
    }

    item.version += 1;
    item.updatedAt = new Date().toISOString();
    item.deletedAt = item.updatedAt;
  }
}

export const createInMemoryItemRepository = () => new InMemoryItemRepository();
