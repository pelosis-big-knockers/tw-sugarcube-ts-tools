// The control, and a check on the advice the warnings give: this file has no
// imports or exports, so it is a script and `Charm` is global. A named global
// type serializes to just its name, which the augmentation can reference — so
// this member is fully typed and must NOT warn.
interface Charm {
  key: string;
  name: string;
  power: number;
}

declare const charms: readonly Charm[];

setup.charms = charms;
