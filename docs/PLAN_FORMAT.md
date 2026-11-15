# Plan format: templates, loops and references

Steps differ per task, but nothing is hardcoded: the LLM writes a small **template** once
(step 1), and values come from the **task input** or from **earlier steps' saved results**.

## Task input (new column: `tasks.input JSONB NOT NULL DEFAULT '{}'`)
```json
POST /tasks
{ "goal": "Grade these schools on fees and results",
  "input": { "schools": [ { "name": "St. Mary's", "city": "Pune" },
                          { "name": "Greenwood High", "city": "Bengaluru" } ] } }
```

## Plan (step 1's saved result)
```json
[
  { "forEach": "$input.schools", "as": "school", "do": [
    { "id": "search", "type": "web_search",
      "args": { "query": "{{school.name}} {{school.city}} school fees" } },
    { "id": "page",   "type": "fetch_page",    "args": { "url": "$search.topUrl" } },
    { "id": "fees",   "type": "llm_summarize", "args": { "textRef": "$page", "focus": "annual fees in INR" } }
  ]},
  { "id": "report", "type": "write_report", "args": { "from": "$fees[*]" } }
]
```

| Syntax | Means |
|---|---|
| `{{school.name}}` | text from the current loop element |
| `$input.schools` | value from the task input |
| `$search.topUrl` | field of this loop iteration's `search` step result |
| `$fees[*]` | all `fees` results across iterations |

zod validates: known step types, args shape per type (after resolution), `forEach` points at a
list, references point at ids defined earlier, total expanded steps ≤ `max_steps`.

## Runner
```ts
async function runTask(ctx: StepContext, input: TaskInput) {
  const plan = await step(ctx, "make_plan", { goal: ctx.goal }, makePlan); // step 1, saved
  const results: Record<string, unknown[]> = {};
  await runItems(ctx, plan, { input }, results);
}

async function runItems(ctx, items, scope, results) {
  for (const item of items) {
    if ("forEach" in item) {
      for (const element of resolve(item.forEach, scope)) {          // input order: fixed
        await runItems(ctx, item.do, { ...scope, [item.as]: element }, results);
      }
    } else {
      const args = resolve(item.args, scope);                         // pure: no I/O, no time
      const out  = await step(ctx, item.type, args, REGISTRY[item.type].run);
      scope[item.id] = out;
      (results[item.id] ??= []).push(out);
    }
  }
}
```

## Expanded run (2 schools)
| step_id | type | resolved args | value came from |
|---|---|---|---|
| 1 | make_plan | goal | task row |
| 2 | web_search | "St. Mary's Pune school fees" | input.schools[0] |
| 3 | fetch_page | url = stmarys.edu/fees | step 2 saved result |
| 4 | llm_summarize | text of step 3 | step 3 |
| 5 | web_search | "Greenwood High Bengaluru school fees" | input.schools[1] |
| 6 | fetch_page | url = greenwood.ac.in/admissions | step 5 saved result |
| 7 | llm_summarize | text of step 6 | step 6 |
| 8 | write_report | steps 4 and 7 | results |

## Why replay is safe
Every value in `scope` comes from the task input or a saved step, the loop order is the input
order, and `resolve()` is pure. So replay rebuilds identical arguments; `input_hash` catches
any difference.
