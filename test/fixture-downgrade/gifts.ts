// A module (it exports), so `Gift` can only be written as an `import(...)` type
// — which the generated augmentation can't reference.
export interface Gift {
  key: string;
  name: string;
  price: number;
}

export const gift: Gift = { key: "flowers", name: "Wildflowers", price: 30 };
