---
name: Telegram map photos
description: Runtime requirement for rendering the live RadarMap image before sending it through Telegram.
---

Динамическое фото карты создаётся локальным headless Chromium, а затем отправляется в Telegram как PNG. Среда Replit предоставляет Chromium по пути `/repl/tools/bin/chromium`; при переносе Python-бота на другой хостинг этот путь может отсутствовать.

**Why:** RadarMap публикует состояние карты как JSON, но не предоставляет готовый endpoint с актуальным изображением карты.

**How to apply:** При переносе бота проверяй наличие Chromium и задавай `CHROMIUM_PATH`, либо сначала добавь отдельный сервис/endpoint для создания изображения; не возвращай ссылку вместо фото без явного согласования.