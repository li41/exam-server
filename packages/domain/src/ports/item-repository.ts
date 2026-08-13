import type {
  CreateItemInput,
  Item,
  ItemListQuery,
  Page,
  UpdateItemInput,
} from "@server-foundation/api-contracts";

export type ItemScope = {
  tenantId: string;
};

export interface ItemRepository {
  list(query: ItemListQuery, scope: ItemScope): Promise<Page<Item>>;
  get(id: string, scope: ItemScope): Promise<Item | null>;
  create(input: CreateItemInput, scope: ItemScope): Promise<Item>;
  update(id: string, input: UpdateItemInput, scope: ItemScope): Promise<Item>;
  softDelete(id: string, version: number, scope: ItemScope): Promise<void>;
}
