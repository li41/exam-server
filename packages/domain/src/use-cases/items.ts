import type {
  CreateItemInput,
  Item,
  ItemListQuery,
  Page,
  UpdateItemInput,
} from "@server-foundation/api-contracts";
import { NotFoundError } from "../errors.js";
import type { ItemRepository, ItemScope } from "../ports/item-repository.js";

export class ItemService {
  constructor(private readonly repository: ItemRepository) {}

  list(query: ItemListQuery, scope: ItemScope): Promise<Page<Item>> {
    return this.repository.list(query, scope);
  }

  async get(id: string, scope: ItemScope): Promise<Item> {
    const item = await this.repository.get(id, scope);
    if (!item) throw new NotFoundError("item", id);
    return item;
  }

  create(input: CreateItemInput, scope: ItemScope): Promise<Item> {
    return this.repository.create(input, scope);
  }

  async update(
    id: string,
    input: UpdateItemInput,
    scope: ItemScope,
  ): Promise<Item> {
    await this.get(id, scope);
    return this.repository.update(id, input, scope);
  }

  async softDelete(
    id: string,
    version: number,
    scope: ItemScope,
  ): Promise<void> {
    await this.get(id, scope);
    await this.repository.softDelete(id, version, scope);
  }
}
