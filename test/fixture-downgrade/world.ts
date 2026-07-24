import { gift } from "./gifts";

// Module-scoped type: nothing wrong with the code, but the augmentation can't
// name the type, so the member is typed `any` and must say so.
setup.gift = gift;

// Ordinary, fully typed member alongside it — the control that must NOT warn.
setup.playerName = "Hero";
