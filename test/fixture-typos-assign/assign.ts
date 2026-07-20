// Object.assign adds members we cannot enumerate, so `setup` must stay open.
Object.assign(setup, { fromAssign: 1 });
const e = setup.somethingWeCannotSee;
