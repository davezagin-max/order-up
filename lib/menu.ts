/**
 * The whole fictional cafe in one typed file: items, sizes, required choices,
 * add-ons, removable ingredients, allergens, combos, and tax.
 *
 * Everything else derives from this file. The order engine prices from it, the
 * system prompt is rendered from it, the tool schemas take their enums from
 * it, and the kitchen panel lists it. Prices are integer cents.
 *
 * The cafe is fictional. Allergen tags describe this made-up menu only.
 */

export const CAFE = {
  name: "Luna Counter",
  tagline: "Counter-service burritos, breakfast all night, and coffee.",
  /** Sales tax in basis points (775 = 7.75%). A flat fictional rate. */
  taxBasisPoints: 775,
} as const;

export const ALLERGENS = ["gluten", "dairy", "egg", "soy", "tree_nuts"] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const ALLERGEN_LABEL: Record<Allergen, string> = {
  gluten: "gluten",
  dairy: "dairy",
  egg: "egg",
  soy: "soy",
  tree_nuts: "tree nuts",
};

export const SIZES = ["small", "regular", "large"] as const;
export type SizeId = (typeof SIZES)[number];

export const CATEGORIES = [
  { id: "mains", name: "Burritos and bowls" },
  { id: "breakfast", name: "Breakfast, all night" },
  { id: "sides", name: "Sides" },
  { id: "drinks", name: "Drinks" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

/**
 * A component is anything that goes into an item: a protein, a milk, an
 * add-on, a default ingredient. Dietary facts live here once, so a line's
 * allergens are computed from what is actually in it.
 */
export interface Component {
  name: string;
  allergens: readonly Allergen[];
  meat?: true;
}

export const COMPONENTS = {
  // Proteins
  chicken: { name: "grilled chicken", allergens: [], meat: true },
  steak: { name: "steak", allergens: [], meat: true },
  carnitas: { name: "carnitas", allergens: [], meat: true },
  barbacoa: { name: "barbacoa", allergens: [], meat: true },
  sofritas: { name: "sofritas", allergens: ["soy"] },
  veggies: { name: "fajita veggie", allergens: [] },
  // Breakfast fillings
  bacon: { name: "bacon", allergens: [], meat: true },
  chorizo: { name: "chorizo", allergens: [], meat: true },
  sausage: { name: "sausage", allergens: [], meat: true },
  potato: { name: "potato and peppers", allergens: [] },
  // Tortillas
  corn: { name: "corn tortillas", allergens: [] },
  flour: { name: "flour tortillas", allergens: ["gluten"] },
  // Salsas
  roja: { name: "red salsa", allergens: [] },
  verde: { name: "green salsa", allergens: [] },
  // Milks
  whole_milk: { name: "whole milk", allergens: ["dairy"] },
  almond_milk: { name: "almond milk", allergens: ["tree_nuts"] },
  soy_milk: { name: "soy milk", allergens: ["soy"] },
  // Drink flavors
  horchata: { name: "horchata", allergens: ["dairy"] },
  jamaica: { name: "hibiscus", allergens: [] },
  sandia: { name: "watermelon", allergens: [] },
  cola: { name: "cola", allergens: [] },
  diet_cola: { name: "diet cola", allergens: [] },
  lemon_lime: { name: "lemon-lime", allergens: [] },
  root_beer: { name: "root beer", allergens: [] },
  // Add-ons
  guac: { name: "guacamole", allergens: [] },
  queso: { name: "queso", allergens: ["dairy"] },
  sour_cream: { name: "sour cream", allergens: ["dairy"] },
  extra_protein: { name: "double protein", allergens: [] },
  fried_egg: { name: "fried egg", allergens: ["egg"] },
  avocado: { name: "avocado", allergens: [] },
  extra_shot: { name: "extra shot", allergens: [] },
  vanilla: { name: "vanilla syrup", allergens: [] },
  // Default ingredients a customer can ask to leave off
  rice: { name: "rice", allergens: [] },
  beans: { name: "black beans", allergens: [] },
  cheese: { name: "cheese", allergens: ["dairy"] },
  pico: { name: "pico de gallo", allergens: [] },
  onions: { name: "onions", allergens: [] },
  cilantro: { name: "cilantro", allergens: [] },
  lettuce: { name: "lettuce", allergens: [] },
  jalapenos: { name: "jalapenos", allergens: [] },
  crema: { name: "crema", allergens: ["dairy"] },
  granola: { name: "granola", allergens: ["gluten", "tree_nuts"] },
  chocolate_sauce: { name: "chocolate sauce", allergens: ["dairy"] },
  whipped_cream: { name: "whipped cream", allergens: ["dairy"] },
  ice: { name: "ice", allergens: [] },
} as const satisfies Record<string, Component>;

export type ComponentId = keyof typeof COMPONENTS;

export interface ChoiceOption {
  id: ComponentId;
  /** Added to the item price when this option is chosen. */
  priceCents: number;
}

export interface ChoiceGroup {
  name: string;
  options: readonly ChoiceOption[];
}

/** Required choices. Every item that lists a group must have exactly one option from it. */
export const GROUPS = {
  protein: {
    name: "protein",
    options: [
      { id: "chicken", priceCents: 0 },
      { id: "steak", priceCents: 150 },
      { id: "carnitas", priceCents: 0 },
      { id: "barbacoa", priceCents: 150 },
      { id: "sofritas", priceCents: 0 },
      { id: "veggies", priceCents: 0 },
    ],
  },
  filling: {
    name: "breakfast filling",
    options: [
      { id: "bacon", priceCents: 0 },
      { id: "chorizo", priceCents: 0 },
      { id: "sausage", priceCents: 0 },
      { id: "potato", priceCents: 0 },
    ],
  },
  tortilla: {
    name: "tortilla",
    options: [
      { id: "corn", priceCents: 0 },
      { id: "flour", priceCents: 0 },
    ],
  },
  salsa: {
    name: "salsa",
    options: [
      { id: "roja", priceCents: 0 },
      { id: "verde", priceCents: 0 },
    ],
  },
  milk: {
    name: "milk",
    options: [
      { id: "whole_milk", priceCents: 0 },
      { id: "almond_milk", priceCents: 60 },
      { id: "soy_milk", priceCents: 60 },
    ],
  },
  agua_flavor: {
    name: "flavor",
    options: [
      { id: "horchata", priceCents: 0 },
      { id: "jamaica", priceCents: 0 },
      { id: "sandia", priceCents: 0 },
    ],
  },
  soda_flavor: {
    name: "flavor",
    options: [
      { id: "cola", priceCents: 0 },
      { id: "diet_cola", priceCents: 0 },
      { id: "lemon_lime", priceCents: 0 },
      { id: "root_beer", priceCents: 0 },
    ],
  },
} as const satisfies Record<string, ChoiceGroup>;

export type GroupId = keyof typeof GROUPS;

/** Optional add-ons. One price everywhere it is offered. */
export const ADD_ONS = {
  guac: { priceCents: 225 },
  queso: { priceCents: 175 },
  sour_cream: { priceCents: 75 },
  veggies: { priceCents: 100 },
  extra_protein: { priceCents: 350 },
  bacon: { priceCents: 200 },
  fried_egg: { priceCents: 150 },
  avocado: { priceCents: 150 },
  extra_shot: { priceCents: 100 },
  vanilla: { priceCents: 75 },
} as const satisfies Partial<Record<ComponentId, { priceCents: number }>>;

export type AddOnId = keyof typeof ADD_ONS;

export interface MenuItem {
  id: string;
  name: string;
  category: CategoryId;
  /** One short line, written to be read aloud. */
  description: string;
  /** Price in cents, or one price per offered size. */
  price: number | Partial<Record<SizeId, number>>;
  /** Used when the customer does not name a size. Only for items with sizes. */
  defaultSize?: SizeId;
  /** Required choice groups, one option each. */
  choices: readonly GroupId[];
  /** The choice whose option leads the spoken name: "carnitas burrito". */
  lead?: GroupId;
  addOns: readonly AddOnId[];
  /** Default ingredients the customer can ask to leave off. */
  removable: readonly ComponentId[];
  /** What is always in it and cannot be removed. */
  base: { allergens: readonly Allergen[]; meat?: true };
  /** Counts as one person's meal when planning a group order. */
  meal: boolean;
}

const MAIN_ADD_ONS = ["guac", "queso", "sour_cream", "veggies", "extra_protein"] as const;

export const ITEMS = [
  // Burritos and bowls
  {
    id: "burrito",
    name: "Burrito",
    category: "mains",
    description: "A flour tortilla with rice, black beans, cheese, pico, onions, and cilantro.",
    price: { regular: 950, large: 1200 },
    defaultSize: "regular",
    choices: ["protein"],
    lead: "protein",
    addOns: MAIN_ADD_ONS,
    removable: ["rice", "beans", "cheese", "pico", "onions", "cilantro"],
    base: { allergens: ["gluten"] },
    meal: true,
  },
  {
    id: "bowl",
    name: "Burrito Bowl",
    category: "mains",
    description: "Everything in the burrito, over lettuce, with no tortilla.",
    price: { regular: 950, large: 1200 },
    defaultSize: "regular",
    choices: ["protein"],
    lead: "protein",
    addOns: MAIN_ADD_ONS,
    removable: ["rice", "beans", "cheese", "pico", "lettuce", "onions", "cilantro"],
    base: { allergens: [] },
    meal: true,
  },
  {
    id: "tacos",
    name: "Street Tacos",
    category: "mains",
    description: "Three tacos with onions, cilantro, and pico.",
    price: 875,
    choices: ["protein", "tortilla"],
    lead: "protein",
    addOns: ["guac", "queso", "extra_protein"],
    removable: ["onions", "cilantro", "pico"],
    base: { allergens: [] },
    meal: true,
  },
  {
    id: "quesadilla",
    name: "Quesadilla",
    category: "mains",
    description: "A griddled flour tortilla with melted cheese and your protein.",
    price: 825,
    choices: ["protein"],
    lead: "protein",
    addOns: ["guac", "queso", "sour_cream"],
    removable: [],
    base: { allergens: ["gluten", "dairy"] },
    meal: true,
  },
  {
    id: "nachos",
    name: "Loaded Nachos",
    category: "mains",
    description: "Corn chips with queso, black beans, pico, and jalapenos.",
    price: 1025,
    choices: ["protein"],
    lead: "protein",
    addOns: ["guac", "sour_cream", "extra_protein"],
    removable: ["beans", "pico", "jalapenos"],
    base: { allergens: ["dairy"] },
    meal: true,
  },
  {
    id: "salad",
    name: "Chopped Salad",
    category: "mains",
    description: "Romaine, black beans, pico, and cheese with a cilantro-lime dressing.",
    price: 925,
    choices: ["protein"],
    lead: "protein",
    addOns: ["guac", "extra_protein"],
    removable: ["beans", "cheese", "pico"],
    base: { allergens: [] },
    meal: true,
  },
  // Breakfast
  {
    id: "breakfast_burrito",
    name: "Breakfast Burrito",
    category: "breakfast",
    description: "Scrambled eggs, cheese, and pico in a flour tortilla.",
    price: 850,
    choices: ["filling"],
    lead: "filling",
    addOns: ["guac", "queso", "sour_cream", "bacon"],
    removable: ["cheese", "pico"],
    base: { allergens: ["gluten", "egg"] },
    meal: true,
  },
  {
    id: "breakfast_tacos",
    name: "Breakfast Tacos",
    category: "breakfast",
    description: "Two tacos with scrambled eggs, cheese, and pico.",
    price: 675,
    choices: ["filling", "tortilla"],
    lead: "filling",
    addOns: ["guac", "queso"],
    removable: ["cheese", "pico"],
    base: { allergens: ["egg"] },
    meal: true,
  },
  {
    id: "chilaquiles",
    name: "Chilaquiles",
    category: "breakfast",
    description: "Corn chips simmered in salsa with two eggs, crema, and cheese.",
    price: 975,
    choices: ["salsa"],
    addOns: ["avocado", "bacon"],
    removable: ["crema", "cheese", "onions"],
    base: { allergens: ["egg"] },
    meal: true,
  },
  {
    id: "avocado_toast",
    name: "Avocado Toast",
    category: "breakfast",
    description: "Smashed avocado on sourdough with pickled onions and cilantro.",
    price: 750,
    choices: [],
    addOns: ["fried_egg", "bacon"],
    removable: ["onions", "cilantro"],
    base: { allergens: ["gluten"] },
    meal: true,
  },
  {
    id: "parfait",
    name: "Yogurt Parfait",
    category: "breakfast",
    description: "Yogurt with fruit and granola.",
    price: 550,
    choices: [],
    addOns: [],
    removable: ["granola"],
    base: { allergens: ["dairy"] },
    meal: false,
  },
  // Sides
  {
    id: "chips_salsa",
    name: "Chips and Salsa",
    category: "sides",
    description: "Corn chips with red salsa.",
    price: 325,
    choices: [],
    addOns: [],
    removable: [],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "chips_guac",
    name: "Chips and Guacamole",
    category: "sides",
    description: "Corn chips with guacamole made in house.",
    price: { regular: 575, large: 875 },
    defaultSize: "regular",
    choices: [],
    addOns: [],
    removable: [],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "chips_queso",
    name: "Chips and Queso",
    category: "sides",
    description: "Corn chips with warm queso.",
    price: 525,
    choices: [],
    addOns: [],
    removable: [],
    base: { allergens: ["dairy"] },
    meal: false,
  },
  {
    id: "rice_beans",
    name: "Rice and Beans",
    category: "sides",
    description: "Cilantro-lime rice and black beans.",
    price: 350,
    choices: [],
    addOns: [],
    removable: [],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "street_corn",
    name: "Street Corn",
    category: "sides",
    description: "Grilled corn with lime mayo, cheese, and chili.",
    price: 450,
    choices: [],
    addOns: [],
    removable: ["cheese"],
    base: { allergens: ["egg"] },
    meal: false,
  },
  {
    id: "tortilla_soup",
    name: "Tortilla Soup",
    category: "sides",
    description: "Chicken and tomato soup with corn tortilla strips and cheese.",
    price: { regular: 550, large: 800 },
    defaultSize: "regular",
    choices: [],
    addOns: ["avocado"],
    removable: ["cheese"],
    base: { allergens: [], meat: true },
    meal: false,
  },
  {
    id: "churros",
    name: "Churros",
    category: "sides",
    description: "Three cinnamon-sugar churros with chocolate sauce.",
    price: 475,
    choices: [],
    addOns: [],
    removable: ["chocolate_sauce"],
    base: { allergens: ["gluten"] },
    meal: false,
  },
  // Drinks
  {
    id: "agua_fresca",
    name: "Agua Fresca",
    category: "drinks",
    description: "Horchata, hibiscus, or watermelon over ice.",
    price: { small: 325, regular: 375, large: 450 },
    defaultSize: "regular",
    choices: ["agua_flavor"],
    lead: "agua_flavor",
    addOns: [],
    removable: ["ice"],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "fountain_soda",
    name: "Fountain Soda",
    category: "drinks",
    description: "Cola, diet cola, lemon-lime, or root beer.",
    price: { small: 225, regular: 275, large: 325 },
    defaultSize: "regular",
    choices: ["soda_flavor"],
    lead: "soda_flavor",
    addOns: [],
    removable: ["ice"],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "drip_coffee",
    name: "Drip Coffee",
    category: "drinks",
    description: "House dark roast.",
    price: { small: 250, regular: 300, large: 350 },
    defaultSize: "regular",
    choices: [],
    addOns: ["vanilla"],
    removable: [],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "latte",
    name: "Latte",
    category: "drinks",
    description: "Espresso with steamed milk.",
    price: { regular: 475, large: 550 },
    defaultSize: "regular",
    choices: ["milk"],
    addOns: ["extra_shot", "vanilla"],
    removable: [],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "cold_brew",
    name: "Cold Brew",
    category: "drinks",
    description: "Steeped overnight, served over ice.",
    price: { regular: 425, large: 500 },
    defaultSize: "regular",
    choices: [],
    addOns: ["vanilla"],
    removable: ["ice"],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "hot_chocolate",
    name: "Mexican Hot Chocolate",
    category: "drinks",
    description: "Dark chocolate and cinnamon with steamed milk and whipped cream.",
    price: { regular: 425, large: 500 },
    defaultSize: "regular",
    choices: ["milk"],
    addOns: [],
    removable: ["whipped_cream"],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "orange_juice",
    name: "Orange Juice",
    category: "drinks",
    description: "Squeezed to order.",
    price: { regular: 400, large: 525 },
    defaultSize: "regular",
    choices: [],
    addOns: [],
    removable: [],
    base: { allergens: [] },
    meal: false,
  },
  {
    id: "bottled_water",
    name: "Bottled Water",
    category: "drinks",
    description: "Still water.",
    price: 200,
    choices: [],
    addOns: [],
    removable: [],
    base: { allergens: [] },
    meal: false,
  },
] as const satisfies readonly MenuItem[];

export type ItemId = (typeof ITEMS)[number]["id"];

/** The same list, typed loosely for code that walks the whole menu. */
export const MENU: readonly MenuItem[] = ITEMS;

/**
 * Combos are the only discounts that exist, and the engine applies them by
 * itself when the cart contains one item from every slot. Slots never share
 * an item, within a combo or across combos, so the count is unambiguous.
 */
export interface Combo {
  id: string;
  name: string;
  slots: readonly (readonly ItemId[])[];
  savingsCents: number;
  /** How a person would say it. */
  description: string;
}

export const COMBOS = [
  {
    id: "counter_combo",
    name: "Counter Combo",
    slots: [
      ["burrito", "bowl", "tacos", "quesadilla", "nachos", "salad"],
      ["chips_salsa", "rice_beans"],
      ["fountain_soda", "agua_fresca"],
    ],
    savingsCents: 200,
    description:
      "Any burrito, bowl, tacos, quesadilla, nachos, or salad, with chips and salsa or rice and beans, and a fountain soda or agua fresca",
  },
  {
    id: "sunrise_combo",
    name: "Sunrise Combo",
    slots: [
      ["breakfast_burrito", "breakfast_tacos", "chilaquiles", "avocado_toast"],
      ["drip_coffee", "orange_juice"],
    ],
    savingsCents: 125,
    description:
      "A breakfast burrito, breakfast tacos, chilaquiles, or avocado toast, with a drip coffee or orange juice",
  },
] as const satisfies readonly Combo[];

// Lookups ---------------------------------------------------------------

const ITEM_BY_ID: ReadonlyMap<string, MenuItem> = new Map(ITEMS.map((item) => [item.id, item]));

export function findItem(id: string): MenuItem | null {
  return ITEM_BY_ID.get(id) ?? null;
}

export function isComponent(id: string): id is ComponentId {
  return Object.prototype.hasOwnProperty.call(COMPONENTS, id);
}

export function isGroup(id: string): id is GroupId {
  return Object.prototype.hasOwnProperty.call(GROUPS, id);
}

export function isAddOn(id: string): id is AddOnId {
  return Object.prototype.hasOwnProperty.call(ADD_ONS, id);
}

export function isSize(id: string): id is SizeId {
  return (SIZES as readonly string[]).includes(id);
}

export function componentName(id: string): string {
  return isComponent(id) ? COMPONENTS[id].name : id;
}

export function sizesOf(item: MenuItem): SizeId[] {
  return typeof item.price === "number"
    ? []
    : SIZES.filter((size) => (item.price as Partial<Record<SizeId, number>>)[size] !== undefined);
}

/** Base price for a size. Callers have already checked the size is offered. */
export function basePrice(item: MenuItem, size: SizeId | null): number {
  if (typeof item.price === "number") return item.price;
  const key = size ?? item.defaultSize ?? sizesOf(item)[0];
  return item.price[key] ?? 0;
}

export const ITEM_IDS: string[] = ITEMS.map((item) => item.id);
export const GROUP_IDS = Object.keys(GROUPS) as GroupId[];
export const ADD_ON_IDS = Object.keys(ADD_ONS) as AddOnId[];

/** Every option of every required-choice group, once. */
export const OPTION_IDS: ComponentId[] = [
  ...new Set(GROUP_IDS.flatMap((group) => GROUPS[group].options.map((option) => option.id))),
];

/** Every ingredient some item lets the customer leave off. */
export const REMOVABLE_IDS: ComponentId[] = [
  ...new Set(ITEMS.flatMap((item) => item.removable as readonly ComponentId[])),
];

/**
 * What the kitchen can run out of: whole items, choice options, and add-ons.
 * Default ingredients are not tracked, to keep the kitchen panel short.
 */
export function isStockable(id: string): boolean {
  return ITEM_BY_ID.has(id) || (OPTION_IDS as string[]).includes(id) || isAddOn(id);
}

/** Display name for a stock id: the item name, or the component name. */
export function stockName(id: string): string {
  return findItem(id)?.name ?? componentName(id);
}
