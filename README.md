# 📸 Instagram Archiver Server

Мощный бэкенд-сервис для автоматического скачивания контента из Instagram и отправки его в Telegram канал. Построен на **Node.js**, **TypeScript** и **Docker**. Использует утилиту `gallery-dl` для извлечения медиа и **Redis** для управления очередью задач.

## 🚀 Возможности

*   **Автоматизация:** Скачивает фото, видео, карусели (альбомы) и Stories.
*   **Метаданные:** Извлекает описание, автора и количество лайков.
*   **Очереди задач:** Использует `BullMQ` + `Redis` для надежной обработки запросов в фоне.
*   **Telegram Bot:** Отправляет контент в канал с красивым форматированием (HTML) и группировкой альбомов.
*   **Архитектура:** Clean Architecture (SOLID) + TypeScript для легкой поддержки.
*   **Docker:** Полная изоляция окружения (Node.js + Python + gallery-dl).

## 🛠 Технический стек

*   **Runtime:** Node.js v20 (Alpine/Slim)
*   **Language:** TypeScript
*   **Downloader:** [gallery-dl](https://github.com/mikf/gallery-dl) (Python)
*   **Queue:** BullMQ & Redis
*   **API:** Express
*   **Bot Framework:** grammY

## ⚙️ Установка и запуск

### Предварительные требования
*   [Docker](https://www.docker.com/) и Docker Compose.
*   Файл `cookies.txt` из вашего браузера (для доступа к Instagram).

### Шаг 1: Конфигурация
1.  Клонируйте репозиторий.
2.  Создайте файл `.env` в корне папки сервера:

```env
PORT=3000
AUTH_SECRET=придумай_сложный_пароль
TELEGRAM_BOT_TOKEN=твой_токен_бота
TELEGRAM_CHANNEL_ID=-1001234567890

# Настройки путей (обычно менять не нужно)
COOKIES_PATH=/app/cookies.txt
DOWNLOAD_PATH=/app/downloads

# Настройки Redis (для Docker Compose)
REDIS_HOST=redis
REDIS_PORT=6379
DOWNLOAD_TIMEOUT_MS=600000
```

`AUTH_SECRET`, `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHANNEL_ID` обязательны. Сервер проверяет настройки до подключения к Redis; запасного ключа доступа нет. `DOWNLOAD_TIMEOUT_MS` ограничивает каждый запуск `gallery-dl` отдельно.

Пример для локального запуска находится в `.env.example`. В Docker путь `/app` соответствует рабочему каталогу контейнера. Боту нужны права публикации в выбранном Telegram-канале.

### Шаг 2: Запуск

Положите `cookies.txt` в корень проекта и запустите:

```sh
docker compose up --build -d
docker compose logs -f app
```

Cookies и скачанные файлы исключены из Git и Docker build context. Файл cookies подключается в контейнер только для чтения.

### API

`POST /api/v1/task` принимает JSON `{"url":"https://www.instagram.com/p/ABC/"}`. Передавайте ключ `AUTH_SECRET` в заголовке `Authorization` без префикса. Ответ `{"status":"queued","jobId":"42"}` означает приём задачи в очередь, а не завершение публикации.

Поддерживаются HTTPS-ссылки на `/p/id/`, `/reel/id/`, `/reels/id/` и конкретную историю `/stories/username/id/` на `instagram.com`, `www.instagram.com` и `m.instagram.com`. Параметры и фрагмент удаляются, адрес приводится к `www.instagram.com`. Ссылки на профиль и историю без ID отклоняются. Некорректные входные данные возвращают `400`, неверный ключ — `403`, тело запроса больше 16 КБ — `413`.

### Проверки

```sh
npm ci
npm run build
npm test
```

Тесты проверяют HTTP API, конфигурацию, подписи и разбиение альбомов Telegram, а также очистку каталогов задач. Они используют имитацию Telegram API и downloader; реальные Instagram, Telegram и Redis не требуются.

Обработка задачи и очистка файлов находятся в `ProcessTask`. Очистка выполняется после попытки отправки, только для каталога задачи внутри `DOWNLOAD_PATH`; ошибка очистки не вызывает повторную публикацию успешно отправленного поста. При retry медиа пока скачиваются заново. Сохранение прогресса частично отправленных альбомов, дедупликация, API статуса и восстановление после перезапуска остаются следующими этапами.
