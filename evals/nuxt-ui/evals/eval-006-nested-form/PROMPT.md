Build an invoice form with dynamic line items using Nuxt UI's nested form support.

Requirements:

1. Create a parent `UForm` with:
   - **Customer** field (`UInput`, name: `customer`)
   - **Date** field (`UInput` with type="date", name: `date`)
2. Below the header fields, render a dynamic list of line items where users can add/remove rows
3. Each line item must be a **nested `UForm`** with:
   - `nested` prop to link validation with the parent form
   - `name` prop using the pattern `items.${index}` to inherit state from parent
   - **Description** field (`UInput`, name: `description`)
   - **Quantity** field (`UInputNumber`, name: `quantity`)
   - **Price** field (`UInputNumber`, name: `price`)
4. Add an "Add Item" button to dynamically push new items
5. Add a "Remove" button per row
6. Use Zod schemas for both the parent form and nested item validation
7. Submit should log the complete form state including all items

The key requirement is using Nuxt UI v4's nested form pattern with `nested` prop and `name` inheritance — nested forms must NOT have their own `:state` prop.
