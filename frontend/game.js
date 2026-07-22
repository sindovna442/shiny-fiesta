// Конфигурация API
const API_BASE = 'http://localhost:5000/api';

// Главный объект игры
const game = {
    petId: null,
    pet: null,
    updateInterval: null,
    editor: null,
    currentSketchId: null,
    
    // Система комнат
    currentRoom: 0,
    rooms: [
        { id: 0, name: '🏠 Гостиная', color: '#1a1a2e', petX: 0.5, petY: 0.55 },
        { id: 1, name: '🍖 Кухня', color: '#2d1810', petX: 0.45, petY: 0.6 },
        { id: 2, name: '🛁 Ванная', color: '#1a2e3e', petX: 0.55, petY: 0.5 },
        { id: 3, name: '😴 Спальня', color: '#1e1a2e', petX: 0.5, petY: 0.58 }
    ],

    // Инициализация игры
    async init() {
        console.log('Initializing game...');
        
        // Создаём или загружаем питомца
        await this.createNewPet();
        
        // Инициализируем редактор рисования
        this.editor = new DrawingEditor();
        
        // Обновляем состояние каждые 2 секунды
        this.startGameLoop();
        
        // Обновляем UI
        this.updateUI();
    },

    // Создать нового питомца
    async createNewPet() {
        try {
            const response = await fetch(`${API_BASE}/pet/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: 'Демонический Кот'
                })
            });
            
            const data = await response.json();
            this.petId = data.pet_id;
            this.pet = data.pet;
            
            console.log('Pet created:', this.petId);
        } catch (error) {
            console.error('Error creating pet:', error);
        }
    },

    // Получить состояние питомца
    async getPetStatus() {
        try {
            const response = await fetch(`${API_BASE}/pet/${this.petId}`);
            const pet = await response.json();
            this.pet = pet;
            return pet;
        } catch (error) {
            console.error('Error fetching pet status:', error);
        }
    },

    // Кормить питомца
    async feedPet() {
        try {
            const response = await fetch(`${API_BASE}/pet/${this.petId}/feed`, {
                method: 'POST'
            });
            const data = await response.json();
            this.pet = data.pet;
            this.addNotification('Кот наслаждается едой! 😋', 'feed');
            this.updateUI();
        } catch (error) {
            console.error('Error feeding pet:', error);
        }
    },

    // Гладить питомца
    async petPet() {
        try {
            const response = await fetch(`${API_BASE}/pet/${this.petId}/pet`, {
                method: 'POST'
            });
            const data = await response.json();
            this.pet = data.pet;
            this.addNotification('Кот мурчит (но делает вид что ему не нравится) 😼', 'pet');
            this.updateUI();
        } catch (error) {
            console.error('Error petting pet:', error);
        }
    },

    // Мыть питомца
    async washPet() {
        try {
            const response = await fetch(`${API_BASE}/pet/${this.petId}/wash`, {
                method: 'POST'
            });
            const data = await response.json();
            this.pet = data.pet;
            this.addNotification('Кот принял ванну! Теперь он чище 🛁', 'wash');
            this.updateUI();
        } catch (error) {
            console.error('Error washing pet:', error);
        }
    },

    // Уложить питомца спать
    async sleepPet() {
        try {
            const response = await fetch(`${API_BASE}/pet/${this.petId}/sleep`, {
                method: 'POST'
            });
            const data = await response.json();
            this.pet = data.pet;
            this.addNotification('Кот сладко спит... Zzz 💤', 'sleep');
            this.updateUI();
        } catch (error) {
            console.error('Error putting pet to sleep:', error);
        }
    },

    // Сбросить игру — завести нового питомца
    async resetPet() {
        if (!confirm('Сбросить игру? Текущий питомец будет заменён новым.')) {
            return;
        }
        try {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
                this.updateInterval = null;
            }
            await this.createNewPet();
            this.startGameLoop();
            this.updateUI();
            this.addNotification('Игра сброшена! Новый демон-кот на сцене 😈🐱', 'reset');
        } catch (error) {
            console.error('Error resetting pet:', error);
        }
    },

    // Цикл обновления игры
    startGameLoop() {
        this.updateInterval = setInterval(() => {
            this.getPetStatus();
            this.updateUI();
            this.drawPet();
        }, 2000);
    },

    // Обновить UI
    updateUI() {
        if (!this.pet) return;

        // Обновляем имя
        document.getElementById('petName').textContent = this.pet.name;

        // Обновляем показатели
        this.updateStat('hunger', this.pet.hunger);
        this.updateStat('cleanliness', this.pet.cleanliness);
        this.updateStat('mood', this.pet.mood);
        this.updateStat('energy', this.pet.energy);
        this.updateStat('health', this.pet.health);

        // Рисуем питомца
        this.drawPet();
    },

    // Обновить показатель
    updateStat(statName, value) {
        value = Math.max(0, Math.min(100, value));
        const barElement = document.getElementById(statName + 'Bar');
        const valueElement = document.getElementById(statName + 'Value');
        
        if (barElement) {
            barElement.style.width = value + '%';
        }
        if (valueElement) {
            valueElement.textContent = Math.round(value);
        }
    },

    // Переключение комнаты
    changeRoom(direction) {
        this.currentRoom += direction;
        if (this.currentRoom < 0) this.currentRoom = this.rooms.length - 1;
        if (this.currentRoom >= this.rooms.length) this.currentRoom = 0;
        
        // Обновляем UI комнаты
        const room = this.rooms[this.currentRoom];
        document.getElementById('roomTitle').textContent = room.name;
        
        // Обновляем dots
        document.querySelectorAll('.dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === this.currentRoom);
        });
        
        // Обновляем фон комнаты
        const roomEl = document.getElementById('currentRoom');
        roomEl.style.background = room.color;
        
        // Перерисовываем питомца в новой позиции
        this.drawPet();
    },

    // Рисование питомца на Canvas
    drawPet() {
        const canvas = document.getElementById('petCanvas');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
        // Рисуем фон комнаты
        const room = this.rooms[this.currentRoom];
        ctx.fillStyle = room.color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Рисуем демон-кота в позиции комнаты
        const petX = canvas.width * room.petX;
        const petY = canvas.height * room.petY;
        this.drawDemonCat(ctx, petX, petY);
    },

    // Функция для рисования кота (3 слоя)
    drawDemonCat(ctx, x, y) {
        const scale = this.getPetScale();
        const breathOffset = Math.sin(Date.now() / 800) * 3;
        const tailSwing = Math.sin(Date.now() / 500) * 15;
        
        // ===== СЛОЙ 1 (ЗАДНИЙ): Хвост + Нижние лапы =====
        
        // Хвост (изгибается, тёмно-красный)
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 14 * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + 70 * scale, y + 30 * scale);
        ctx.quadraticCurveTo(
            x + 120 * scale, 
            y + 60 * scale + tailSwing, 
            x + 140 * scale, 
            y + 40 * scale
        );
        ctx.stroke();
        
        // Кончик хвоста (стрелка)
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        const tailEndX = x + 140 * scale;
        const tailEndY = y + 40 * scale;
        const tailAngle = Math.atan2(-20, 20);
        ctx.moveTo(tailEndX + 10 * scale, tailEndY);
        ctx.lineTo(tailEndX - 5 * scale, tailEndY - 12 * scale);
        ctx.lineTo(tailEndX - 5 * scale, tailEndY + 12 * scale);
        ctx.closePath();
        ctx.fill();
        
        // Нижние лапы (задние)
        ctx.fillStyle = '#e74c3c';
        // Левая задняя лапа
        ctx.beginPath();
        ctx.ellipse(x - 35 * scale, y + 65 * scale + breathOffset, 22 * scale, 15 * scale, -0.3, 0, Math.PI * 2);
        ctx.fill();
        // Правая задняя лапа
        ctx.beginPath();
        ctx.ellipse(x + 35 * scale, y + 65 * scale + breathOffset, 22 * scale, 15 * scale, 0.3, 0, Math.PI * 2);
        ctx.fill();
        
        // ===== СЛОЙ 2 (СРЕДНИЙ): Тело с животиком =====
        
        // Тело (круглое, красное)
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.ellipse(x, y + breathOffset, 70 * scale, 65 * scale, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // Животик (светло-розовый, овальный)
        ctx.fillStyle = '#ff9999';
        ctx.beginPath();
        ctx.ellipse(x, y + 15 * scale + breathOffset, 45 * scale, 40 * scale, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // Пупок (крестик)
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 3 * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - 6 * scale, y + 15 * scale + breathOffset);
        ctx.lineTo(x + 6 * scale, y + 15 * scale + breathOffset);
        ctx.moveTo(x, y + 9 * scale + breathOffset);
        ctx.lineTo(x, y + 21 * scale + breathOffset);
        ctx.stroke();
        
        // Улыбка под пупком
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 3 * scale;
        ctx.beginPath();
        ctx.arc(x, y + 30 * scale + breathOffset, 12 * scale, 0.2, Math.PI - 0.2);
        ctx.stroke();
        
        // ===== СЛОЙ 3 (ПЕРЕДНИЙ): Голова + Верхние лапы + Лицо =====
        
        // Верхние лапы (руки)
        ctx.fillStyle = '#e74c3c';
        // Левая рука
        ctx.beginPath();
        ctx.ellipse(x - 65 * scale, y - 10 * scale + breathOffset, 18 * scale, 28 * scale, -0.4, 0, Math.PI * 2);
        ctx.fill();
        // Пальцы левой руки
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.ellipse(
                x - 70 * scale + i * 8 * scale, 
                y - 35 * scale + breathOffset,
                5 * scale, 8 * scale, 0, 0, Math.PI * 2
            );
            ctx.fill();
        }
        // Правая рука
        ctx.beginPath();
        ctx.ellipse(x + 65 * scale, y - 10 * scale + breathOffset, 18 * scale, 28 * scale, 0.4, 0, Math.PI * 2);
        ctx.fill();
        // Пальцы правой руки
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.ellipse(
                x + 60 * scale + i * 8 * scale, 
                y - 35 * scale + breathOffset,
                5 * scale, 8 * scale, 0, 0, Math.PI * 2
            );
            ctx.fill();
        }
        
        // Голова (круглая)
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.arc(x, y - 55 * scale + breathOffset, 55 * scale, 0, Math.PI * 2);
        ctx.fill();
        
        // Ушки (кошачьи, острые)
        ctx.fillStyle = '#e74c3c';
        // Левое ухо
        ctx.beginPath();
        ctx.moveTo(x - 45 * scale, y - 80 * scale + breathOffset);
        ctx.lineTo(x - 25 * scale, y - 120 * scale + breathOffset);
        ctx.lineTo(x - 10 * scale, y - 75 * scale + breathOffset);
        ctx.closePath();
        ctx.fill();
        // Правое ухо
        ctx.beginPath();
        ctx.moveTo(x + 45 * scale, y - 80 * scale + breathOffset);
        ctx.lineTo(x + 25 * scale, y - 120 * scale + breathOffset);
        ctx.lineTo(x + 10 * scale, y - 75 * scale + breathOffset);
        ctx.closePath();
        ctx.fill();
        
        // Щёчки (полоски)
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 3 * scale;
        // Левые полоски
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(x - 55 * scale, y - 55 * scale + i * 12 * scale + breathOffset);
            ctx.lineTo(x - 40 * scale, y - 55 * scale + i * 12 * scale + breathOffset);
            ctx.stroke();
        }
        // Правые полоски
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(x + 55 * scale, y - 55 * scale + i * 12 * scale + breathOffset);
            ctx.lineTo(x + 40 * scale, y - 55 * scale + i * 12 * scale + breathOffset);
            ctx.stroke();
        }
        
        // Глаза (取决于 настроения)
        const eyeY = y - 60 * scale + breathOffset;
        if (this.pet.mood > 70) {
            // Счастливые глаза (^^)
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 3 * scale;
            ctx.beginPath();
            ctx.arc(x - 18 * scale, eyeY, 10 * scale, Math.PI + 0.3, -0.3);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x + 18 * scale, eyeY, 10 * scale, Math.PI + 0.3, -0.3);
            ctx.stroke();
        } else if (this.pet.mood > 30) {
            // Обычные глаза
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.arc(x - 18 * scale, eyeY, 8 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + 18 * scale, eyeY, 8 * scale, 0, Math.PI * 2);
            ctx.fill();
            // Блики
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.arc(x - 15 * scale, eyeY - 3 * scale, 3 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + 21 * scale, eyeY - 3 * scale, 3 * scale, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Грустные глаза
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.ellipse(x - 18 * scale, eyeY + 3 * scale, 8 * scale, 6 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(x + 18 * scale, eyeY + 3 * scale, 8 * scale, 6 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Рот
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 3 * scale;
        ctx.beginPath();
        if (this.pet.mood > 50) {
            // Улыбка
            ctx.arc(x, y - 45 * scale + breathOffset, 10 * scale, 0.3, Math.PI - 0.3);
        } else if (this.pet.mood < 30) {
            // Грусть
            ctx.arc(x, y - 38 * scale + breathOffset, 10 * scale, Math.PI + 0.3, -0.3);
        } else {
            // Нейтрально
            ctx.moveTo(x - 8 * scale, y - 45 * scale + breathOffset);
            ctx.lineTo(x + 8 * scale, y - 45 * scale + breathOffset);
        }
        ctx.stroke();
        
        // Носик (треугольник)
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.moveTo(x, y - 50 * scale + breathOffset);
        ctx.lineTo(x - 5 * scale, y - 45 * scale + breathOffset);
        ctx.lineTo(x + 5 * scale, y - 45 * scale + breathOffset);
        ctx.closePath();
        ctx.fill();
        
        // Спальный пузырь
        if (this.pet.energy < 30) {
            ctx.fillStyle = 'rgba(100, 100, 100, 0.7)';
            const bubbleY = y - 140 * scale;
            ctx.beginPath();
            ctx.arc(x + 40 * scale, bubbleY, 30 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'white';
            ctx.font = `bold ${28 * scale}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Zzz', x + 40 * scale, bubbleY);
        }
    },

    // Получить масштаб в зависимости от стадии
    getPetScale() {
        const scales = [0.8, 1.0, 1.2, 0.9];
        return scales[this.pet.stage] || 1.0;
    },

    // Добавить уведомление
    addNotification(text, type) {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = text;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: white;
            padding: 15px 20px;
            border-radius: 10px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
            animation: slideIn 0.3s ease;
            z-index: 1000;
        `;
        
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
    },

    // Навигация на скетчбук
    goToSketch() {
        this.switchScreen('sketchScreen');
        this.loadSketches();
    },

    // Вернуться в главное меню
    backToMain() {
        this.switchScreen('mainScreen');
    },

    // Вернуться к списку скетчей
    backToSketchList() {
        this.switchScreen('sketchScreen');
    },

    // Перейти к мини-играм
    goToMinigames() {
        this.switchScreen('minigamesScreen');
    },

    // Запустить мини-игру (заглушка)
    startMinigame(gameName) {
        this.addNotification(`Мини-игра "${gameName}" скоро будет! 🎮`, 'info');
    },

    // Переключение экрана
    switchScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(screenId).classList.add('active');
    },

    // Загрузить скетчи
    async loadSketches() {
        try {
            const response = await fetch(`${API_BASE}/sketches/${this.petId}`);
            const data = await response.json();
            
            const sketchList = document.getElementById('sketchList');
            sketchList.innerHTML = '';
            
            // Кнопка создания
            const createBtn = document.createElement('button');
            createBtn.className = 'create-sketch-btn';
            createBtn.innerHTML = '➕ Создать новый рисунок';
            createBtn.onclick = () => this.newSketch();
            sketchList.appendChild(createBtn);
            
            // Рисунки
            data.sketches.forEach(sketch => {
                const item = document.createElement('div');
                item.className = 'sketch-item';
                item.innerHTML = `
                    <img src="${sketch.imageData}" class="sketch-item-preview" alt="${sketch.title}">
                    <div class="sketch-item-title">${sketch.title}</div>
                    <button class="sketch-item-delete" onclick="game.deleteSketch('${sketch.id}', event)">✕</button>
                `;
                item.onclick = () => this.editSketch(sketch.id);
                sketchList.appendChild(item);
            });
        } catch (error) {
            console.error('Error loading sketches:', error);
        }
    },

    // Создать новый рисунок
    newSketch() {
        this.currentSketchId = null;
        this.editor.clear();
        this.switchScreen('editorScreen');
    },

    // Редактировать существующий рисунок
    async editSketch(sketchId) {
        try {
            const response = await fetch(`${API_BASE}/sketches/${this.petId}/${sketchId}`);
            const sketch = await response.json();
            
            this.currentSketchId = sketchId;
            this.editor.loadImage(sketch.imageData);
            this.switchScreen('editorScreen');
        } catch (error) {
            console.error('Error loading sketch:', error);
        }
    },

    // Удалить рисунок
    async deleteSketch(sketchId, event) {
        event.stopPropagation();
        
        try {
            await fetch(`${API_BASE}/sketches/${this.petId}/${sketchId}`, {
                method: 'DELETE'
            });
            this.loadSketches();
        } catch (error) {
            console.error('Error deleting sketch:', error);
        }
    },

    // Сохранить рисунок
    async saveSketch() {
        const imageData = this.editor.getImageData();
        const title = prompt('Назовите ваш рисунок:', `Рисунок ${new Date().toLocaleString()}`);
        
        if (!title) return;
        
        try {
            const response = await fetch(`${API_BASE}/sketches/${this.petId}/save`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    title,
                    imageData
                })
            });

            if (!response.ok) {
                throw new Error('Save failed: HTTP ' + response.status);
            }

            const data = await response.json();
            this.addNotification('Рисунок сохранён! Кот был в восторге! 😻', 'success');

            // Обновляем настроение питомца
            await this.getPetStatus();
            this.updateUI();

            // Перезагружаем список перед переключением, иначе новый рисунок
            // не появится до повторного захода в скетчбук (фикс UX-бага).
            await this.loadSketches();

            this.backToSketchList();
        } catch (error) {
            console.error('Error saving sketch:', error);
            this.addNotification(
                'Не удалось сохранить рисунок. Попробуйте ещё раз.',
                'error'
            );
        }
    },

    // Скачать текущий рисунок как PNG
    exportSketch() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = 'sketch-' + stamp + '.png';
        this.editor.canvas.toBlob((blob) => {
            if (!blob) {
                this.addNotification('Не удалось экспортировать рисунок 😿', 'error');
                return;
            }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            this.addNotification('Скачано: ' + filename + ' 📥', 'success');
        }, 'image/png');
    }
};

// Класс редактора рисования
class DrawingEditor {
    constructor() {
        this.canvas = document.getElementById('drawingCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.isDrawing = false;
        this.currentTool = 'brush';
        this.brushSize = 5;
        this.brushColor = '#000000';
        this.history = [];
        this.historyStep = 0;
        this.historyLimit = 20;

        this.setupCanvas();
        this.setupEventListeners();
        this.updateHistoryIndicator();
    }

    // Обновить индикатор истории ↶ step/total ↷
    updateHistoryIndicator() {
        const el = document.getElementById('historyIndicator');
        if (!el) return;
        const total = this.history.length;
        const step = this.historyStep;
        el.textContent = '↶ ' + step + '/' + total + ' ↷';
    }

    setupCanvas() {
        // Заполняем белым
        this.ctx.fillStyle = 'white';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.saveHistory();
    }

    setupEventListeners() {
        this.canvas.addEventListener('mousedown', (e) => this.startDrawing(e));
        this.canvas.addEventListener('mousemove', (e) => this.draw(e));
        this.canvas.addEventListener('mouseup', () => this.stopDrawing());
        this.canvas.addEventListener('mouseleave', () => this.stopDrawing());

        // Сенсорные события
        this.canvas.addEventListener('touchstart', (e) => this.startDrawing(e));
        this.canvas.addEventListener('touchmove', (e) => this.draw(e));
        this.canvas.addEventListener('touchend', () => this.stopDrawing());
    }

    startDrawing(e) {
        this.isDrawing = true;
        const rect = this.canvas.getBoundingClientRect();
        const x = (e.clientX || e.touches[0].clientX) - rect.left;
        const y = (e.clientY || e.touches[0].clientY) - rect.top;
        
        this.ctx.beginPath();
        this.ctx.moveTo(x, y);
    }

    draw(e) {
        if (!this.isDrawing) return;
        
        const rect = this.canvas.getBoundingClientRect();
        const x = (e.clientX || e.touches[0].clientX) - rect.left;
        const y = (e.clientY || e.touches[0].clientY) - rect.top;
        
        if (this.currentTool === 'brush') {
            this.ctx.strokeStyle = this.brushColor;
            this.ctx.lineWidth = this.brushSize;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            this.ctx.lineTo(x, y);
            this.ctx.stroke();
        } else if (this.currentTool === 'eraser') {
            this.ctx.clearRect(x - this.brushSize / 2, y - this.brushSize / 2, this.brushSize, this.brushSize);
        }
    }

    stopDrawing() {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.ctx.closePath();
            this.saveHistory();
        }
    }

    selectTool(tool) {
        this.currentTool = tool;
        document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
        
        if (tool === 'brush') {
            document.getElementById('brushTool').classList.add('active');
        } else if (tool === 'eraser') {
            document.getElementById('eraserTool').classList.add('active');
        }
    }

    setBrushSize(size) {
        this.brushSize = size;
        document.getElementById('sizeDisplay').textContent = size;
    }

    setColor(color) {
        this.brushColor = color;
    }

    clear() {
        this.ctx.fillStyle = 'white';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.history = [];
        this.historyStep = 0;
        this.saveHistory();
    }

    saveHistory() {
        this.historyStep++;
        if (this.historyStep < this.history.length) {
            this.history.length = this.historyStep;
        }
        this.history.push(this.canvas.toDataURL());
        // Кап истории: отбрасываем самое старое сверх лимита
        if (this.history.length > this.historyLimit) {
            const overflow = this.history.length - this.historyLimit;
            this.history.splice(0, overflow);
            this.historyStep = Math.max(0, this.historyStep - overflow);
        }
        this.updateHistoryIndicator();
    }

    undo() {
        if (this.historyStep > 0) {
            this.historyStep--;
            this.loadImageData(this.history[this.historyStep]);
            this.updateHistoryIndicator();
        }
    }

    redo() {
        if (this.historyStep < this.history.length - 1) {
            this.historyStep++;
            this.loadImageData(this.history[this.historyStep]);
            this.updateHistoryIndicator();
        }
    }

    loadImage(imageData) {
        const img = new Image();
        img.onload = () => {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(img, 0, 0);
            this.saveHistory();
        };
        img.src = imageData;
    }

    loadImageData(imageData) {
        const img = new Image();
        img.onload = () => {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(img, 0, 0);
        };
        img.src = imageData;
    }

    getImageData() {
        return this.canvas.toDataURL('image/png');
    }
}

// Инициализируем игру при загрузке страницы
window.addEventListener('load', () => {
    game.init();
});
