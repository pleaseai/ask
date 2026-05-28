import pleaseai from '@pleaseai/eslint-config'

export default pleaseai(
  {
    vue: true,
  },
  {
    // MDC syntax (`#headline`, `::component`, `:::block`) parses as
    // invalid Markdown to ESLint's `markdown` plugin. Skip content/.
    ignores: ['content/**/*.md'],
  },
)
