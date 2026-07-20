// A container we cannot fully enumerate must stay open even with typos on.
const key = "computed" as string;
State.temporary[key] = 1;
const d = State.temporary.anythingAtAll;
