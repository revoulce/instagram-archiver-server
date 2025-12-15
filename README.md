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
TELEGRAM_CHANNEL_ID=-1001234567890 (ID канала)

# Настройки путей (обычно менять не нужно)
COOKIES_PATH=/app/cookies.txt
DOWNLOAD_PATH=/app/downloads

# Настройки Redis (для Docker Compose)
REDIS_HOST=redis
REDIS_PORT=6379