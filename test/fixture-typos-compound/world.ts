// Members created ONLY through compound assignments must still count as real
// members when typo detection is on — not typos.
setup.greet = (): string => "hi";     // a plain member, so `setup` is closable

State.variables.gold ??= 0;           // logical-assign: contributes gold + type
State.variables.hp += 5;              // arithmetic compound: existence/site only

const g: number = State.variables.gold;   // reading the ??=-created member
const h = State.variables.hp;              // reading the +=-created member
