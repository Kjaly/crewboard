# Crewboard documentation · Документация Crewboard

English is the source text; the Russian guides are maintained translations with the same file names.
Английский текст — основной; русские руководства — поддерживаемый перевод с теми же именами файлов.

| Guide | English | Русский |
| --- | --- | --- |
| Getting started · Начало работы | [getting-started.md](en/getting-started.md) | [getting-started.md](ru/getting-started.md) |
| Plugin setup · Подключение плагина | [plugin-setup.md](en/plugin-setup.md) | [plugin-setup.md](ru/plugin-setup.md) |
| CLI reference · Справочник CLI | [cli.md](en/cli.md) | [cli.md](ru/cli.md) |
| Workers · Воркеры | [workers.md](en/workers.md) | [workers.md](ru/workers.md) |
| Review and decisions · Приёмка и решения | [review.md](en/review.md) | [review.md](ru/review.md) |
| Costs · Затраты | [costs.md](en/costs.md) | [costs.md](ru/costs.md) |
| Troubleshooting · Если что-то не работает | [troubleshooting.md](en/troubleshooting.md) | [troubleshooting.md](ru/troubleshooting.md) |

## For contributors · Для участников

These pages are in English only. · Эти страницы только на английском.

- [Architecture](architecture.md) — packages, data flow, trust boundary, dsh integration.
- [Releasing](releasing.md) — npm packages, trusted publishing, repository settings.
- [Contributing](../CONTRIBUTING.md) · [Changelog](../CHANGELOG.md) · [Security](../SECURITY.md)

Screenshots live in `assets/` with language-neutral names; captions and alt text are written in each guide's language.
Скриншоты лежат в `assets/` под нейтральными именами; подписи и альтернативный текст — на языке каждого руководства.

`pnpm lint` checks that every relative link and image in the READMEs and `docs/` resolves and that each English guide has a Russian twin.
`pnpm lint` проверяет, что все относительные ссылки и картинки в README и `docs/` существуют и у каждого английского руководства есть русская пара.
