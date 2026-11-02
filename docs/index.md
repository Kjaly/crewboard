---
layout: page
title: Crewboard
---

<script setup>
import { onMounted } from 'vue'
import { useRouter, withBase } from 'vitepress'

// The site's front door: Russian browsers land on the Russian home, everyone else on the English one.
const router = useRouter()
onMounted(() => router.go(withBase(navigator.language.toLowerCase().startsWith('ru') ? '/ru/' : '/en/')))
</script>

[English](./en/) · [Русский](./ru/)
