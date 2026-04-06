Build a command palette using Nuxt UI's `CommandPalette` component with grouped commands.

Requirements:

1. Use the `UCommandPalette` component with the `groups` prop
2. Create at least 2 groups:
   - **Actions** group (`id: 'actions'`) with items like "New File", "New Folder", "Save"
   - **Navigation** group (`id: 'navigation'`) with items like "Home", "Settings", "Profile"
3. Each item must have a `label` and an `icon` prop (use Lucide icons like `i-lucide-file-plus`)
4. At least one item should have `kbds` (keyboard shortcut hints), e.g. `['meta', 'N']`
5. At least one item should have an `onSelect` callback that logs to console
6. Bind the selected value with `v-model`

The palette should be visible on the page (not hidden behind a keyboard shortcut).
