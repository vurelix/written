# Help Treasure Map and Settings Restoration Design

## Objective

Revise the Help experience so each category is a single animated dropdown. Expanded categories display their articles as interactive stops on a dotted treasure-map route. Selecting an article opens its content in an accessible modal.

This change also temporarily disables the Economic calendar widget, standardizes small interface symbols on native platform emoji and symbol fonts, and restores the Performance setting.

## Scope

### Help category dropdowns

- Render every Help category as a collapsed accordion card.
- Allow at most one category to be open.
- Selecting a closed category closes the current category and opens the selected category.
- Selecting the open category closes it.
- Animate the category body with a height reveal, opacity transition, slight vertical movement, and rotating disclosure indicator.
- Keep content mounted during the animation so relationships expressed through `aria-controls` remain valid.
- Remove movement when the operating system requests reduced motion.

### Treasure-map article route

- Lay out each expanded category's articles as numbered interactive nodes.
- Connect the nodes with a curved dotted SVG route on wider layouts.
- Use a vertical dotted route at narrow widths so article labels do not overlap.
- Generate the route from category article order rather than hard-coding article-specific coordinates.
- Give each node a clear hover and keyboard-focus state using lift, border emphasis, accent glow, and route emphasis.
- Use native buttons for article nodes.
- Keep node labels readable independently of their number or route position.

### Article modal

- Open the selected article in a centered modal above a dimmed backdrop.
- Show the article title, existing paragraph or numbered-step content, and any existing action button.
- Allow only one article modal to be open.
- Close the modal from its close button, the Escape key, or a backdrop click.
- Trap keyboard focus inside the modal while it is open.
- Restore focus to the article node that opened the modal after closing.
- Lock background scrolling while the modal is open.
- Expose dialog semantics with `role="dialog"`, `aria-modal="true"`, and a labelled title.
- Keep the expanded category open after closing its article modal.

### Help search behavior

- Preserve the current search field and answer-text matching.
- Filter categories and article nodes according to the query.
- Automatically open the first category containing a match.
- Do not automatically open an article modal.
- Return to the user's previous category selection when the query is cleared when possible; otherwise leave the first available category open.
- Continue announcing the result count through the existing live region.

### Economic calendar

- Remove Economic calendar from the active widget registry so it does not appear on the dashboard or in the add-widget picker.
- Ignore a previously persisted `econ` widget entry and remove it from the normalized widget order.
- Retain the dormant rendering and sample-data implementation so the feature can be re-enabled later without reconstructing it.
- Do not add or connect an external calendar provider in this change.

### Platform symbols and emoji

- Use a shared native symbol font stack:
  `Apple Color Emoji`, `Segoe UI Emoji`, `Segoe UI Symbol`, and `system-ui`.
- Apply it to interface glyphs such as close, check, status, and shortcut symbols instead of relying on the bundled text font.
- Preserve platform-specific shortcut labels, including `⌘K` on macOS and `Ctrl K` on Windows and Linux.
- Keep accessible names independent of the visible glyph.
- Use a plain Unicode or text fallback if a preferred color emoji is unavailable.

### Performance setting

- Render the Performance setting in Settings regardless of whether the desktop preference bridge is detected.
- Preserve the existing Full, Reduced, and Maximum modes.
- In the desktop application, read, write, and listen through `window.desktopPrefs`.
- In browser previews, update `data-perf` locally so the control remains functional.
- Keep the native View menu and Settings selection synchronized when the bridge is available.

## State model

Help uses two independent pieces of state:

- `helpOpenCategoryId`: the one expanded category, or `null`.
- `helpOpenArticleId`: the article displayed in the modal, or `null`.

Opening another category clears the article modal before changing categories. Opening an article records its triggering node for focus restoration. Closing a category also closes any article belonging to it.

Search may temporarily change `helpOpenCategoryId`, but it never changes `helpOpenArticleId`.

## Animation behavior

- Category reveal: approximately 260 ms with a cubic-bezier ease, using a grid-row or measured-height transition plus opacity and translate.
- Disclosure indicator: approximately 180 ms rotation.
- Node hover: approximately 160 ms lift, scale, border, and shadow transition.
- Modal entrance and exit: approximately 200 ms backdrop fade plus dialog opacity and scale transition.
- Reduced-motion mode: transitions become effectively immediate and transforms are removed.

Animations must not depend on fixed content heights.

## Responsive behavior

- Desktop and wide tablet: alternating or gently staggered nodes connected by a curved dotted route.
- Narrow tablet and phone: a vertical route with nodes aligned to one side and labels beside them.
- Modal width is capped for comfortable reading and uses viewport-safe margins.
- Long article titles wrap without colliding with nodes or route segments.

## Error and edge states

- A category with one article shows one numbered node and no connector segment.
- A category with no matching search results is not rendered.
- If a saved open category no longer exists, fall back to the first available category.
- If the modal's trigger disappears due to search or navigation, restore focus to the category button or Help search field.
- Navigation away from Help closes the article modal and releases scroll locking.

## Verification

### Logic tests

- Only one Help category can be open.
- Opening a new category closes the previous category and any open article.
- Modal state opens and closes without collapsing its category.
- Search opens the first matching category but never auto-opens a modal.
- Clearing search restores a valid category state.
- Economic calendar is absent from rendered and addable widget collections, including persisted layouts.
- Performance choices remain valid with and without the desktop bridge.
- Platform shortcut labels and symbol fallbacks resolve correctly.

### Browser tests

- Category buttons expose correct `aria-expanded` and `aria-controls` values.
- Category content animates and remains keyboard accessible.
- Treasure-map nodes have visible hover and focus states.
- Clicking a node opens the correct modal.
- Escape, backdrop, and close-button dismissal work.
- Focus is trapped in the modal and restored after closing.
- Background scrolling is locked only while the modal is open.
- Responsive route layouts do not overlap at supported viewport sizes.
- Reduced-motion mode avoids movement-heavy transitions.
- Economic calendar is absent from the widget picker and saved dashboard layouts.
- Performance is visible and selectable in Settings.

## Out of scope

- Connecting to an economic calendar provider.
- Rewriting Help article copy.
- Adding new Help categories or articles.
- Replacing larger application illustrations or charts with emoji.
