# Mobile routine builder

The household-management screen uses the routine list builder on screens up to
1024px wide when a routine template is selected. **Routine builder** opens it
from the canvas at any size; **Canvas view** returns to the existing editor.
`/leader/dashboard?view=list` opens the list directly.

This is connected to the signed-in household. It supports creating routines,
adding/editing/removing template tasks and rewards, choosing household members,
editing prerequisites, daily/weekly schedules, and starting live task boards.
Member tokens share the desktop planner's colour mapping and profile photos.
Existing task-board snapshots are not rewritten when templates are edited.

**Try it out** only simulates prerequisite completion in memory. It does not
write task completions, run schedules, or simulate time/expiry rules. Advanced
task time/expiry conditions and monthly/yearly schedules remain editable in the
canvas and are preserved by mobile task saves.

Task saves use the existing authenticated flow endpoint's `createTask` and
`updateTask` actions, with an explicit prerequisite list. Existing management
permissions and kiosk restrictions apply. The `savePlannerTask` helper atomically saves basic task
fields, assignees and prerequisites. It verifies household/routine membership,
validates assignees and dependencies, rejects cycles, and preserves time rules
and canvas positions. New prerequisites are limited to the selected routine;
legacy links from other routines are retained unless explicitly removed.

Run model checks with:

```sh
node --experimental-strip-types --test tests/routine-planner.test.mjs
npm run build
```

The original standalone browser-local demo remains separate and is not used
by the deployed routine builder.
