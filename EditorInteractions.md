# Editor Interactions — Test Checklist

Manual QA checklist for all editor interaction features. Check each item after changes to `index.html`.

---

## 1. Cursor & Editing Basics

- [ ] Clicking anywhere in the editor body places the caret at that position
- [ ] Typing immediately inserts text at the caret
- [ ] Editor title (`#editorTitle`) is editable; typing sets the note title
- [ ] Pressing Enter in the title moves focus to the body
- [ ] Pressing Backspace at the start of the body when empty does not delete the title

---

## 2. Text Selection

### Mouse selection
- [ ] Click-drag selects a range of text
- [ ] Double-click selects the word under the cursor
- [ ] Triple-click selects the entire paragraph

### Keyboard selection
- [ ] Shift+Arrow keys extend the selection character/line by character/line
- [ ] Cmd+A (Mac) / Ctrl+A (Win/Linux) selects all text in the body

---

## 3. Floating Format Toolbar

- [ ] Selecting text shows the format bar above the selection
- [ ] Format bar hides when the selection is collapsed (single click, Escape, or clicking away)
- [ ] **Bold (B)** — clicking applies `<strong>` / toggling removes it
- [ ] **Italic (I)** — clicking applies `<em>` / toggling removes it
- [ ] **Underline (U)** — clicking applies `<u>` / toggling removes it
- [ ] Active format buttons appear highlighted when selection is inside that format
- [ ] **Link button** — clicking opens the URL input panel below the toolbar
  - [ ] Typing a URL and pressing Apply wraps selection in `<a>`
  - [ ] Pressing Apply on an empty URL removes an existing link (`unlink`)
  - [ ] Pressing Enter in the URL input applies the link
- [ ] **Clear formatting button** — removes all inline formatting from selection
- [ ] **AI button (✦)** — closes format bar and opens the floating AI chat for the selection
- [ ] Pressing **Escape** closes the format bar (and link panel if open)
- [ ] Clicking outside the format bar collapses it
- [ ] Clicking format bar buttons does **not** collapse the selection (selection is preserved)

---

## 4. Block / Paragraph Handle

- [ ] Hovering over a paragraph in the editor reveals the drag handle (⠿) to its left
- [ ] Moving the mouse away hides the handle after a short delay
- [ ] Hovering over the handle itself keeps it visible
- [ ] Clicking the handle opens the **Block Type Menu**

### Block Type Menu
- [ ] Menu shows: Text, Heading 1, Heading 2, Heading 3, Bullet list, Numbered list, Quote
- [ ] Selecting **Text** converts the block to `<p>`
- [ ] Selecting **Heading 1** converts the block to `<h1>`
- [ ] Selecting **Heading 2** converts the block to `<h2>`
- [ ] Selecting **Heading 3** converts the block to `<h3>`
- [ ] Selecting **Bullet list** converts the block to `<ul><li>`
- [ ] Selecting **Numbered list** converts the block to `<ol><li>`
- [ ] Selecting **Quote** converts the block to `<blockquote>`
- [ ] Block type changes are auto-saved

---

## 5. Drag to Reorder

- [ ] Dragging the handle moves the block with a ghost preview
- [ ] A blue insertion line appears between blocks as you drag
- [ ] Releasing the drag inserts the block at the indicated position
- [ ] The dragged block is dimmed (opacity) while dragging
- [ ] Dragging to the **red delete zone** at the bottom of the viewport removes the block
- [ ] Delete zone shows a trash icon and "Drop here to delete" label
- [ ] Reorder is saved automatically after drop
- [ ] Pressing Escape while dragging cancels the drag and returns the block to its original position (or simply: releasing outside a valid target does nothing destructive)

---

## 6. Slash Command Menu

- [ ] Typing `/` on an empty paragraph opens the slash menu
- [ ] Typing more characters after `/` filters the list
- [ ] Arrow Up / Arrow Down navigate the menu items
- [ ] Pressing Enter or clicking an item applies the command
- [ ] Pressing Escape closes the menu without applying
- [ ] Commands available and working:
  - [ ] **H1** — `Heading 1`
  - [ ] **H2** — `Heading 2`
  - [ ] **H3** — `Heading 3`
  - [ ] **Bullets** — unordered list
  - [ ] **Numbers** — ordered list
  - [ ] **Quote** — blockquote
  - [ ] **Divider** — inserts `<hr>`

---

## 7. Keyboard Shortcuts

| Shortcut | Expected behaviour |
|---|---|
| Cmd/Ctrl + B | Toggle **bold** on selection |
| Cmd/Ctrl + I | Toggle *italic* on selection |
| Cmd/Ctrl + U | Toggle underline on selection |
| Cmd/Ctrl + K | Open link panel for current selection |
| Cmd/Ctrl + Z | Undo last change |
| Cmd/Ctrl + Shift + Z | Redo |
| Tab (in list) | Indent list item |
| Shift + Tab (in list) | Outdent list item |
| Escape | Close format bar / slash menu / link panel |

- [ ] All shortcuts above work as expected
- [ ] Cmd+B / Cmd+I / Cmd+U close the format bar after applying (no stale toolbar)
- [ ] Cmd+K opens the link panel when text is selected
- [ ] Tab / Shift+Tab only prevent default scroll behaviour inside lists

---

## 8. Formatting Persistence

- [ ] Bold / italic / underline applied in one session survives a page reload
- [ ] Heading levels (`h1`, `h2`, `h3`) survive a page reload
- [ ] Lists (`ul`, `ol`) survive a page reload
- [ ] Blockquotes survive a page reload
- [ ] Links survive a page reload
- [ ] Block order after drag-reorder survives a page reload

---

## 9. New Note Flow

- [ ] Clicking **New Note** immediately creates a blank document with focus in the editor — no modal
- [ ] The AI helper bar appears at the bottom with the prompt: *"Not sure where to start? Tell me what you want to write — I'll draft it."*
- [ ] Submitting a prompt in the AI helper populates an empty doc with a generated title + body
- [ ] Submitting a prompt when the doc already has content inserts generated text at the current caret position
- [ ] The AI helper can be dismissed by clicking away or pressing Escape
- [ ] The spinner appears while the AI is generating and disappears on completion

---

## 10. Mobile / Touch (basic)

- [ ] Tapping places the caret correctly on mobile
- [ ] Native selection handles appear on long-press
- [ ] Format bar appears after native text selection
- [ ] Slash menu opens when typing `/` on mobile keyboard

---

## 11. Accessibility

- [ ] Format bar has `role="toolbar"` and `aria-label="Text formatting"`
- [ ] Each format button has a descriptive `aria-label` (e.g. "Bold (⌘B)")
- [ ] Block type menu has `role="menu"`
- [ ] Drag handle and insert line have `aria-hidden="true"` / are non-focusable
- [ ] All interactive elements are keyboard focusable (Tab order is logical)
- [ ] `@media (prefers-reduced-motion: reduce)` disables toolbar transitions

---

*Last updated: 2026-02-23*
