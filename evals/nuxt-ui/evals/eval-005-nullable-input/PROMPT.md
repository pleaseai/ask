Build a user profile form using Nuxt UI components with proper null handling.

Requirements:

1. Create a form with the following fields:
   - **Name** (`UInput`): Required text field
   - **Nickname** (`UInput`): Optional field that should be `null` when left empty (not an empty string)
   - **Bio** (`UTextarea`): Optional field that should be `null` when left empty
   - **Age** (`UInputNumber`): Optional number field that should be `null` when cleared
2. Use `UForm` with a Zod schema for validation
3. Use `UFormField` for each field with proper labels and names
4. Empty optional fields must convert to `null` (not empty string `""`)  — use the appropriate Nuxt UI v4 model modifier
5. Add a submit button that logs the form state to console
6. Display the current form state as JSON below the form for debugging

Focus on correct v-model modifier usage for null conversion in Nuxt UI v4.
