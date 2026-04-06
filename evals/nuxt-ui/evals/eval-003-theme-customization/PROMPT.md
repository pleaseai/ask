Customize the Nuxt UI theme to create a branded look with the following requirements:

1. **Primary color**: Change the primary color to `indigo` using `app.config.ts`
2. **Secondary color**: Set secondary to `rose`
3. **Custom font**: In the CSS file, use the `@theme` directive to set a custom sans font family to `'Inter', sans-serif`
4. **Demo page**: Create a page that showcases the theme with:
   - A `UButton` with `color="primary"` showing the indigo theme
   - A `UButton` with `color="secondary"` showing the rose theme
   - A `UCard` component wrapping some content
   - A `UBadge` component

The key requirement is using Nuxt UI v4's CSS-first theming approach with the `@theme` directive in CSS and `app.config.ts` for color configuration.
