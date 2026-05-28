export default defineAppConfig({
  docs: {
    title: 'ASK',
    github: {
      url: 'https://github.com/pleaseai/ask',
      owner: 'pleaseai',
      name: 'ask',
      branch: 'main',
    },
  },
  github: {
    rootDir: 'apps/docs',
  },
  ui: {
    pageHero: {
      slots: {
        title: 'font-semibold sm:text-6xl',
        container: '!pb-0',
      },
    },
    pageCard: {
      slots: {
        container: 'lg:flex min-w-0',
        wrapper: 'flex-none',
      },
    },
  },
})
