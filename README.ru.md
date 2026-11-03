# Crewboard

[English](README.md) | **Русский**

[![CI](https://github.com/Kjaly/crewboard/actions/workflows/ci.yml/badge.svg)](https://github.com/Kjaly/crewboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Ведите агентов из одного чата и следите, что они делают.**

Вы разговариваете с одним ведущим чатом: Claude Code, Codex, dsh или любым MCP-клиентом. Через Crewboard он раздаёт работу Codex, Claude, DeepSeek или любому агенту, которого вы зарегистрируете, включая Kimi и GLM через dsh, отвечает на их вопросы и закрывает работу по критериям, о которых вы договорились. Crewboard — это локальный экран рядом: что происходит прямо сейчас, кто чем занят, из какого разговора это выросло и сколько стоило.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ru/now-dark.png">
  <img alt="Экран «Сейчас»: слева проекты и цели, в центре живое дерево поручений, справа контекст выбранного поручения." src="docs/assets/ru/now-light.png">
</picture>

[![Короткий проход: ответ на вопрос исполнителя, просьба передать работу другому провайдеру, история и аналитика.](docs/assets/ru/walkthrough.gif)](docs/assets/ru/walkthrough.mp4)

Документация: **[kjaly.github.io/crewboard/ru](https://kjaly.github.io/crewboard/ru/)** (те же руководства, что в [`docs/`](docs/README.md), с поиском).

## Как это работает

1. **Вы договариваетесь с ведущим, что хотите получить.** В чате ведущего опишите цель. Ведущий спросит, что ему нужно, и вместе с вами определит критерии готовности.
2. **Ведущий раздаёт работу.** Инструментами Crewboard по MCP он ставит цель и поручает части Codex, Claude, DeepSeek или любому агенту, которого вы добавили. Каждое поручение помнит, кто его дал, что должно получиться и из какой реплики оно родилось.
3. **Исполнители сначала спрашивают ведущего.** Вопрос исполнителя уходит ведущему. До вас доходит только то, что ведущий решить не может: вкус, объём работы, деньги.
4. **Ведущий закрывает работу.** Он сверяет итог с критериями и закрывает его или возвращает с замечанием. Принимать работу вам не нужно, но вмешаться можно в любой момент.
5. **Вы управляете из дерева.** Попросите уточнить, остановить, передать другому провайдеру, начать раньше или переоткрыть. Каждое действие — просьба к ведущему. Его решение окончательное, спорить с ним можно в чате.

## Установка

С Node.js 22.15+:

```sh
npx crewboard serve
```

Или установите один раз командой `npm install -g crewboard` и запускайте `crewboard serve`. Из исходников (Node.js 22.15+, pnpm 11.5.2, Git):

```sh
git clone https://github.com/Kjaly/crewboard.git
cd crewboard
pnpm install --frozen-lockfile
pnpm build
node packages/crewboard/dist/main.js serve
```

Откройте http://127.0.0.1:4700/. Экран покажет, какие исполнители готовы и как подключить ведущего — любой MCP-клиент. Из терминала то же самое двумя командами:

```sh
crewboard doctor           # какие исполнители могут работать здесь и что поставить для остальных
crewboard connect claude   # или: codex, dsh, other
```

При установке из исходников `crewboard` — это `node packages/crewboard/dist/main.js`.

В Claude Code вместо `crewboard connect claude` можно поставить плагин Crewboard: он подключает сервер и добавляет навык, который учит ведущего раздавать, проверять и закрывать работу. В чате Claude Code (версии 2.1.275 и новее):

```text
/plugin install crewboard --marketplace Kjaly/crewboard
```

Или из терминала:

```sh
claude plugin marketplace add Kjaly/crewboard
claude plugin install crewboard@crewboard
```

Выберите что-то одно: плагин и `claude mcp add` подключили бы один и тот же сервер дважды.

Дальше в чате ведущего внутри одного из ваших репозиториев опишите, что хотите. [Руководство по началу работы](docs/ru/getting-started.md) проводит через первую цель.

## Что нужно каждому исполнителю

| Исполнитель | Что нужно |
| --- | --- |
| Codex | CLI `codex`, вход выполнен (`codex login`) |
| Claude | CLI `claude` с тем входом, которым вы пользуетесь сами (подписка Claude или ключ API) |
| DeepSeek | `dsh` (DeepSeek Harness) с ключом DeepSeek в его настройках |
| Любой другой агент | запись в `~/.crewboard/agents.json`: OpenCode, Cursor, Gemini, Grok, Devin или Kimi, GLM и другие модели через dsh |

Модели, значения по умолчанию и то, как исполнитель сам делит работу, описаны в [руководстве по исполнителям](docs/ru/workers.md). Внизу боковой панели видно, сколько израсходовано из лимитов подписок и сколько денег осталось на DeepSeek и Kimi; что для этого нужно каждому — в разделе [«Провайдеры»](docs/ru/screen.md#провайдеры).

## Документация

- [Начало работы](docs/ru/getting-started.md)
- [Ведущий](docs/ru/lead.md): инструменты MCP, ожидание новостей, вопросы и просьбы
- [Исполнители](docs/ru/workers.md)
- [Экран](docs/ru/screen.md): «Сейчас», просьбы из дерева, «История», «Аналитика»
- [Затраты](docs/ru/costs.md)
- [Если что-то не так](docs/ru/troubleshooting.md)
- [Архитектура](docs/architecture.md) · [Как помочь проекту](CONTRIBUTING.md) · [Безопасность](SECURITY.md) · [Изменения](CHANGELOG.md)

## Состояние

Версия 1.2.0. Используется на macOS с Claude Code, Codex CLI и DeepSeek Harness. На Linux должно работать, на Windows не проверялось. Сервер слушает только 127.0.0.1 и своей авторизации не имеет, подробнее в разделе о [безопасности](SECURITY.md).
