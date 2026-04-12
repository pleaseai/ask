<script setup lang="ts">
const { data: entries } = await useAsyncData('registry', () =>
  queryCollection('registry').all(),
)

const search = ref('')

const filtered = computed(() => {
  if (!entries.value)
    return []
  if (!search.value)
    return entries.value
  const q = search.value.toLowerCase()
  return entries.value.filter(e =>
    e.name.toLowerCase().includes(q)
    || e.description.toLowerCase().includes(q)
    || e.tags?.some((t: string) => t.toLowerCase().includes(q)),
  )
})
</script>

<template>
  <div class="py-12">
    <div class="text-center mb-12">
      <h1 class="text-4xl font-bold mb-4">
        ASK Registry
      </h1>
      <p class="text-lg text-gray-500 dark:text-gray-400">
        Library documentation registry for AI coding agents
      </p>
    </div>

    <UInput
      v-model="search"
      placeholder="Search libraries..."
      icon="i-heroicons-magnifying-glass"
      size="lg"
      class="mb-8 max-w-lg mx-auto"
    />

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <NuxtLink
        v-for="entry in filtered"
        :key="entry.stem"
        :to="`/${entry.stem}`"
        class="block"
      >
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-lg">
              {{ entry.name }}
            </h3>
          </div>
        </template>

        <p class="text-sm text-gray-500 dark:text-gray-400">
          {{ entry.description }}
        </p>

        <div v-if="entry.tags?.length" class="mt-3 flex flex-wrap gap-1">
          <UBadge
            v-for="tag in entry.tags"
            :key="tag"
            variant="outline"
            size="xs"
          >
            {{ tag }}
          </UBadge>
        </div>

        <template #footer>
          <code class="text-xs">ask add {{ entry.repo }}</code>
        </template>
      </UCard>
      </NuxtLink>
    </div>

    <div v-if="filtered?.length === 0" class="text-center py-12 text-gray-400">
      No results found.
    </div>
  </div>
</template>
