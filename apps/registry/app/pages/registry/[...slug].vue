<script setup lang="ts">
const route = useRoute()
const path = `/registry/${(route.params.slug as string[]).join('/')}`

const { data: entry } = await useAsyncData(`registry-${path}`, () =>
  queryCollection('registry').path(path).first(),
)

if (!entry.value) {
  throw createError({ statusCode: 404, message: 'Library not found' })
}
</script>

<template>
  <div v-if="entry" class="py-12 max-w-3xl mx-auto">
    <div class="mb-8">
      <NuxtLink to="/" class="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
        &larr; Back to registry
      </NuxtLink>
    </div>

    <div class="flex items-center gap-3 mb-6">
      <h1 class="text-3xl font-bold">
        {{ entry.name }}
      </h1>
      <UBadge variant="subtle" size="lg">
        {{ entry.ecosystem }}
      </UBadge>
    </div>

    <p class="text-lg text-gray-500 dark:text-gray-400 mb-6">
      {{ entry.description }}
    </p>

    <div v-if="entry.tags?.length" class="flex flex-wrap gap-2 mb-8">
      <UBadge
        v-for="tag in entry.tags"
        :key="tag"
        variant="outline"
      >
        {{ tag }}
      </UBadge>
    </div>

    <UCard class="mb-8">
      <template #header>
        <h2 class="font-semibold">
          Quick Start
        </h2>
      </template>
      <code class="text-sm">ask docs add {{ entry.ecosystem }}:{{ entry.name }}</code>
    </UCard>

    <div v-if="entry.strategies?.length" class="mb-8">
      <h2 class="text-xl font-semibold mb-4">
        Source Strategies
      </h2>
      <div class="space-y-3">
        <UCard v-for="(strategy, i) in entry.strategies" :key="i">
          <div class="flex items-center gap-2 mb-2">
            <UBadge>{{ strategy.source }}</UBadge>
            <span v-if="strategy.repo" class="text-sm text-gray-500">{{ strategy.repo }}</span>
            <span v-if="strategy.package" class="text-sm text-gray-500">{{ strategy.package }}</span>
          </div>
          <div class="text-sm text-gray-500 dark:text-gray-400 space-y-1">
            <p v-if="strategy.docsPath">
              Docs path: <code>{{ strategy.docsPath }}</code>
            </p>
            <p v-if="strategy.urls?.length">
              URLs: {{ strategy.urls.join(', ') }}
            </p>
          </div>
        </UCard>
      </div>
    </div>

    <ContentRenderer :value="entry" class="prose dark:prose-invert max-w-none" />
  </div>
</template>
