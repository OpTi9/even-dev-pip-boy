# misc helper projects

This folder contains optional helper projects for development workflows.

## editor

- Path: `misc/editor`
- Source: `https://github.com/langerhans/even-ui-builder`
- Type: git submodule
- Purpose: auxiliary UI helper project for even-dev (not part of `apps/*` runtime app selection)

`misc/editor` is intentionally separate from the glasses runtime app list. Use it to generate UI source for `apps/quicktest`.

Initialize/update all submodules from repository root:

```bash
git submodule update --init --recursive
```

Update only this helper project:

```bash
git submodule update --remote misc/editor
```

Run the helper editor launcher (installs deps + starts dev server):

```bash
./misc/editor.sh
```

### Use editor output in quicktest

From repository root, use this practical flow:

1. Start editor:

```bash
./misc/editor.sh
```

2. In editor UI, create layout and copy the generated TypeScript.
3. Use one of these:
   - Paste into quicktest textarea (`Quicktest source`) in the browser.
   - Replace `apps/quicktest/generated-ui.ts` with generated source.
4. Run simulator with quicktest:

```bash
APP_NAME=quicktest ./start-even.sh
```

5. In the app page, paste/edit code in the quicktest textarea and click **Render Quicktest UI**.

Notes:
- The generated code should define `const container = new CreateStartUpPageContainer(...)`.
- `import ... from '@evenrealities/even_hub_sdk'` and `export default container` are supported; quicktest strips them before compiling.
- After first render, clicking **Render Quicktest UI** rebuilds from current textarea content.
- Bridge button/list events are logged in browser console (`[quicktest] bridge event`).
- `quicktest` is intended for fast iteration; edit `generated-ui.ts`, refresh, and reconnect.
