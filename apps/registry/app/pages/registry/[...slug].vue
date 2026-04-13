<script setup lang="ts">
const route = useRoute()
const stem = `registry/${(route.params.slug as string[]).join('/')}`

const { data: entry } = await useAsyncData(`registry-${stem}`, () =>
  queryCollection('registry').where('stem', '=', stem).first())

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
      <code class="text-sm">ask add {{ entry.packages?.length === 1 && entry.packages[0]?.aliases?.[0] ? `${entry.packages[0].aliases[0].ecosystem}:${entry.packages[0].aliases[0].name}` : entry.repo }}</code>
    </UCard>

    <div v-if="entry.packages?.length" class="mb-8">
      <h2 class="text-xl font-semibold mb-4">
        Packages
      </h2>
      <div class="space-y-3">
        <UCard v-for="(pkg, i) in entry.packages" :key="i">
          <div class="flex items-center gap-2 mb-2">
            <span class="font-medium">{{ pkg.name }}</span>
          </div>
          <div class="text-sm text-gray-500 dark:text-gray-400 space-y-1">
            <p v-if="pkg.aliases?.length">
              Aliases: {{ pkg.aliases.map((a: { ecosystem: string, name: string }) => `${a.ecosystem}:${a.name}`).join(', ') }}
            </p>
            <p>
              Sources: {{ pkg.sources.map((s: { type: string }) => s.type).join(', ') }}
            </p>
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>
