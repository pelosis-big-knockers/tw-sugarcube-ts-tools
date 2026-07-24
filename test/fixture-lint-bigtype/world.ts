// A table of items is the ordinary way a story declares its data, and its
// serialized type is long: every literal member of every row is written out.
// Three rows already run past 400 characters, which the analyzer's old cap
// treated as pathological and typed `any`.
const gifts = [
  { key: "flowers", name: "Wildflowers", lower: "wildflowers", price: 30, points: 2 },
  { key: "chocolate", name: "Tin of Chocolates", lower: "tin of chocolates", price: 50, points: 3 },
  { key: "jewelry", name: "Costume Jewelry", lower: "costume jewelry", price: 80, points: 5 },
] as const;

setup.gifts = gifts;

// The same shape as bare strings stays well under any cap — it is the control
// that always worked, and it must keep working.
setup.names = ["Tim", "Bob", "Joe"] as const;

// Errors only if the recovered types are real rather than `any`.
export const wrongPrice: string = setup.gifts[0].price;
export const wrongName: number = setup.names[0];
