// A story whose variables are unions: `$item` is null until the player picks
// one up, `$mix` is set to different types in different passages. Everything a
// passage does with them is only sound after an `<<if>>` has narrowed them.
interface Item {
  name: string;
}

setup.makeItem = (): Item => ({ name: "sword" });
setup.useItem = (item: Item): string => item.name;
setup.needNumber = (n: number): number => n * 2;
