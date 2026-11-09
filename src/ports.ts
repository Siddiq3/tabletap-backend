// Ports: what the API needs from storage and login. One folder in src/adapters per backend.
import type {
  DiningTable, Menu, MenuCategory, MenuItem, Membership, NewMenuItem, NewRestaurant,
  Order, OrderStatus, PaymentMethod, PlaceOrderInput, Restaurant,
} from "./contract";

export interface RestaurantRepo {
  getBySlug(slug: string): Promise<Restaurant | null>;
  getMembership(userId: string): Promise<Membership | null>;
  slugTaken(slug: string): Promise<boolean>;
  create(input: NewRestaurant, ownerUserId: string): Promise<string>;
  update(restaurantId: string, patch: Partial<Pick<Restaurant, "name" | "address" | "upiId" | "taxPercent">>): Promise<void>;
  listTables(restaurantId: string): Promise<DiningTable[]>;
  getTable(restaurantId: string, tableId: string): Promise<DiningTable | null>;
  addTables(restaurantId: string, labels: string[]): Promise<void>;
}

export interface MenuRepo {
  list(restaurantId: string, opts?: { availableOnly?: boolean }): Promise<Menu>;
  addCategory(restaurantId: string, name: string): Promise<MenuCategory>;
  addItem(restaurantId: string, item: NewMenuItem): Promise<MenuItem>;
  updateItem(restaurantId: string, itemId: string, patch: Partial<NewMenuItem & { isAvailable: boolean }>): Promise<void>;
  deleteItem(restaurantId: string, itemId: string): Promise<void>;
}

export interface OrderRepo {
  place(input: PlaceOrderInput): Promise<{ orderId: string; orderNo: number; totalPaise: number }>;
  get(restaurantId: string, orderId: string): Promise<Order | null>;
  /** Open orders of any age, plus everything from today (IST). */
  listBoard(restaurantId: string): Promise<Order[]>;
  setStatus(restaurantId: string, orderId: string, status: OrderStatus): Promise<void>;
  markPaid(restaurantId: string, orderId: string, method: PaymentMethod): Promise<void>;
}

export interface Repos {
  restaurants: RestaurantRepo;
  menu: MenuRepo;
  orders: OrderRepo;
}

/** Turns a login token from web or app into a user id, or null if invalid/expired. */
export interface AuthVerifier {
  verify(token: string): Promise<string | null>;
}
