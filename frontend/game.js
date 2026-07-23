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
    hoveredItem: null,
    dragState: { active: false, type: null, index: -1, offsetX: 0, offsetY: 0, startX: 0, startY: 0 },
    particles: [],

    // rAF-animation loop for pet canvas (gated to mainScreen)
    _petAnimFrame: null,
    _petAnimLoopRunning: false,
    _mainScreenActive: false,
    // Perf cache: getPetScale() is constant for the current canvas
    // backing store; compute once on first use, reuse thereafter.
    _petScale: null,
    _petDirty: false,

    // ===== In-app perf HUD (off by default; enable with ?perf=1) =====
    _perfEnabled: false,
    _drawCaller: null,
    _perfTotals: { rAF: 0, redrawPetNow: 0, updateUI: 0,
                   changeRoom: 0, movePetToItem: 0, leak: 0,
                   _1sRing: null, _1sRingHead: 0 },
    
    // Система звука
    audioCtx: null,
    
    // Система реакций кота
    catReaction: null,
    settleDropStart: 0,
    settleDropKind: null,
    reactionEndTime: 0,
    rooms: [
        { id: 0, name: '🏠 Гостиная', color: '#1a1a2e', petX: 0.5, petY: 0.55 },
        { id: 1, name: '🍖 Кухня', color: '#2d1810', petX: 0.35, petY: 0.55,
          item: { type: 'foodBowl', x: 0.7, y: 0.72, w: 0.18, h: 0.15, label: 'Нажми, чтобы покормить', action: 'feedPet' } },
        { id: 2, name: '🛁 Ванная', color: '#1a2e3e', petX: 0.35, petY: 0.48,
          item: { type: 'bathtub', x: 0.62, y: 0.65, w: 0.25, h: 0.22, label: 'Нажми, чтобы войти/выйти из ванны', action: 'toggleBath' } },
        { id: 3, name: '😴 Спальня', color: '#1e1a2e', petX: 0.3, petY: 0.55,
          item: { type: 'bed', x: 0.6, y: 0.6, w: 0.28, h: 0.25, label: 'Нажми, чтобы лечь/встать', action: 'toggleBed' } }
    ],

    // Инициализация игры
    async init() {
        console.log('Initializing game...');

        // Try to reuse the saved petId from localStorage first.
        const reused = await this.tryReuseExistingPet();
        if (!reused) {
            await this.createNewPet();
        }

        // Drawing editor
        this.editor = new DrawingEditor();

        // Canvas event handlers
        this.setupCanvasEvents();

        // AudioContext
        this.initAudio();

        // 2-second stats tick
        this.startGameLoop();

        // Update UI
        this.updateUI();

        // Pet animation rAF loop (gated to mainScreen)
        this.startPetAnimLoop();

        // ---- Perf HUD: enable if URL has ?perf=1 or localStorage set.
        try {
            var _url = new URL(window.location.href);
            var _ls = (function(){try{return localStorage.getItem("dcmPerfHud")==="1";}catch(_){return false;}})();
            this._perfEnabled = (_url.searchParams.get("perf") === "1") || _ls;
        } catch (_) { this._perfEnabled = false; }
        if (this._perfEnabled) {
            this._perfTotals._1sRing = new Array(60).fill("");
            window.__perf = {
                totals: this._perfTotals,
                reset: function () {
                    var t = game._perfTotals;
                    for (var k in t) if (typeof t[k] === "number") t[k] = 0;
                    t._1sRingHead = 0;
                },
                lastSecond: function () {
                    var r = game._perfTotals._1sRing || [];
                    var c = { rAF: 0, redrawPetNow: 0, updateUI: 0,
                              changeRoom: 0, movePetToItem: 0, leak: 0 };
                    for (var i = 0; i < r.length; i++) {
                        if (c[r[i]] !== undefined) c[r[i]]++;
                    }
                    return c;
                }
            };
        }
    },

    // Инициализация аудио
    initAudio() {
        try {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.log('Web Audio API не поддерживается');
        }
    },

    // Генерация звука мяуканья
    playMeow() {
        if (!this.audioCtx) return;
        
        // Возобновляем контекст если заблокирован
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        
        const now = this.audioCtx.currentTime;
        
        // Основной тон мяуканья (частота меняется)
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.1);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.3);
        
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
        
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        
        osc.start(now);
        osc.stop(now + 0.4);
        
        // Второй тон для более реалистичного звука
        const osc2 = this.audioCtx.createOscillator();
        const gain2 = this.audioCtx.createGain();
        
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(900, now + 0.05);
        osc2.frequency.exponentialRampToValueAtTime(1400, now + 0.15);
        osc2.frequency.exponentialRampToValueAtTime(500, now + 0.35);
        
        gain2.gain.setValueAtTime(0.15, now + 0.05);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.45);
        
        osc2.connect(gain2);
        gain2.connect(this.audioCtx.destination);
        
        osc2.start(now + 0.05);
        osc2.stop(now + 0.45);
    },

    // Звук мурчания
    playPurr() {
        if (!this.audioCtx) return;
        
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        
        const now = this.audioCtx.currentTime;
        
        // Низкочастотное мурчание
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        const lfo = this.audioCtx.createOscillator();
        const lfoGain = this.audioCtx.createGain();
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(25, now);
        
        lfo.type = 'sine';
        lfo.frequency.setValueAtTime(20, now);
        lfoGain.gain.setValueAtTime(10, now);
        
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.3);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.8);
        
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        
        osc.start(now);
        osc.stop(now + 0.8);
        lfo.start(now);
        lfo.stop(now + 0.8);
    },

    // Звук недовольного кота
    playAngryMeow() {
        if (!this.audioCtx) return;
        
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        
        const now = this.audioCtx.currentTime;
        
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.linearRampToValueAtTime(200, now + 0.3);
        
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        
        osc.start(now);
        osc.stop(now + 0.35);
    },

    // Получить случайную реакцию
    getRandomReaction() {
        const reactions = ['angry', 'cute', 'purr'];
        return reactions[Math.floor(Math.random() * reactions.length)];
    },

    // Активировать реакцию кота
    triggerReaction() {
        const type = this.getRandomReaction();
        this.catReaction = type;
        this.reactionEndTime = Date.now() + 1500;
        
        // Звук в зависимости от реакции
        if (type === 'angry') {
            this.playAngryMeow();
        } else if (type === 'purr') {
            this.playPurr();
        } else {
            this.playMeow();
        }
    },

    // Обработчики: drag, клик, hover
    setupCanvasEvents() {
        const canvas = document.getElementById('petCanvas');
        if (!canvas) return;
        
        const self = this;
        
        // Получить координаты мыши относительно canvas
        function getCanvasCoords(e) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left) * (canvas.width / rect.width),
                y: (e.clientY - rect.top) * (canvas.height / rect.height)
            };
        }
        
        // === Drag-and-Drop ===
        let dragMoved = false;
        
        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const { x, y } = getCanvasCoords(e);
            dragMoved = false;
            
            const room = self.rooms[self.currentRoom];
            
            // Проверяем клик по коту
            const petX = canvas.width * room.petX;
            const petY = canvas.height * room.petY;
            const scale = self.getPetScale();
            const catRadius = 70 * scale;
            const dist = Math.sqrt((x - petX) ** 2 + (y - petY) ** 2);
            
            if (dist < catRadius) {
                self.dragState.active = true;
                self.dragState.type = 'pet';
                self.dragState.offsetX = x - petX;
                self.dragState.offsetY = y - petY;
                canvas.style.cursor = 'grabbing';
                return;
            }
            
            // Проверяем клик по предмету комнаты
            if (room.item) {
                const item = room.item;
                const itemX = canvas.width * item.x;
                const itemY = canvas.height * item.y;
                const itemW = canvas.width * item.w;
                const itemH = canvas.height * item.h;
                
                if (x >= itemX - itemW/2 && x <= itemX + itemW/2 &&
                    y >= itemY - itemH/2 && y <= itemY + itemH/2) {
                    self.dragState.active = true;
                    self.dragState.type = 'item';
                    self.dragState.offsetX = x - itemX;
                    self.dragState.offsetY = y - itemY;
                    canvas.style.cursor = 'grabbing';
                    return;
                }
            }
        });
        
        canvas.addEventListener('mousemove', (e) => {
            const { x, y } = getCanvasCoords(e);
            
            if (self.dragState.active) {
                dragMoved = true;
                const room = self.rooms[self.currentRoom];
                
                if (self.dragState.type === 'pet') {
                    // Двигаем кота
                    room.petX = Math.max(0.05, Math.min(0.95, (x - self.dragState.offsetX) / canvas.width));
                    room.petY = Math.max(0.1, Math.min(0.9, (y - self.dragState.offsetY) / canvas.height));
                } else if (self.dragState.type === 'item' && room.item) {
                    // Двигаем предмет
                    room.item.x = Math.max(0.05, Math.min(0.95, (x - self.dragState.offsetX) / canvas.width));
                    room.item.y = Math.max(0.05, Math.min(0.95, (y - self.dragState.offsetY) / canvas.height));
                }
                
                self.requestPetDraw();
                return;
            }
            
            // Hover (троттлинг 50ms)
            const now = Date.now();
            if (now - self._lastHoverTime < 50) return;
            self._lastHoverTime = now;
            self.handleCanvasHover(x, y, canvas);
        });
        
        canvas.addEventListener('mouseup', (e) => {
            if (!self.dragState.active) return;
            
            const wasPet = self.dragState.type === 'pet';
            self.dragState.active = false;
            self.dragState.type = null;
            canvas.style.cursor = 'default';
            
            // Если не было движения — это клик, а не drag
            if (!dragMoved) {
                const { x, y } = getCanvasCoords(e);
                self.handleCanvasClick(x, y);
                return;
            }
            
            // === DROP ZONE === если кота перетащили на предмет
            if (wasPet) {
                const room = self.rooms[self.currentRoom];
                if (room.item) {
                    const item = room.item;
                    const petX = canvas.width * room.petX;
                    const petY = canvas.height * room.petY;
                    const itemX = canvas.width * item.x;
                    const itemY = canvas.height * item.y;
                    const itemW = canvas.width * item.w;
                    const itemH = canvas.height * item.h;
                    const scale = self.getPetScale();
                    const catRadius = 70 * scale;
                    
                    // Проверяем пересечение кота с предметом
                    const dx = petX - itemX;
                    const dy = petY - itemY;
                    const overlapX = catRadius + itemW / 2;
                    const overlapY = catRadius + itemH / 2;
                    
                    if (Math.abs(dx) < overlapX && Math.abs(dy) < overlapY * 0.7) {
                        // Срабатывает действие предмета!
                        if (item.action === 'toggleBath' || item.action === 'toggleBed') {
                            if (item.action === 'toggleBath') {
                                self.addNotification('Кот упал в ванну! 🛁', 'wash');
                            } else {
                                self.addNotification('Кот завалился спать! 💤', 'sleep');
                            }
                        } else if (item.action === 'feedPet') {
                            self.addNotification('Кот подобрал еду! 🍖', 'feed');
                        }
                        self[item.action]();
                        self.spawnParticles(item.type, itemX, itemY);
                    }
                }
            }
        });
        
        // Сброс hover при уходе курсора
        canvas.addEventListener('mouseleave', () => {
            self.hoveredItem = null;
            canvas.style.cursor = 'default';
            if (!self.dragState.active) {
                self.requestPetDraw();
            } else {
                self.dragState.active = false;
                self.dragState.type = null;
                self.requestPetDraw();
            }
        });
        
        this._lastHoverTime = 0;
    },

    // Обработка клика по Canvas
    handleCanvasClick(x, y) {
        const canvas = document.getElementById('petCanvas');
        const room = this.rooms[this.currentRoom];
        
        // Сначала проверяем клик по предмету комнаты
        if (room.item) {
            const item = room.item;
            const itemX = canvas.width * item.x;
            const itemY = canvas.height * item.y;
            const itemW = canvas.width * item.w;
            const itemH = canvas.height * item.h;
            
            if (x >= itemX - itemW/2 && x <= itemX + itemW/2 &&
                y >= itemY - itemH/2 && y <= itemY + itemH/2) {
                // Для toggle-предметов (ванна, кровать) не спавним частицы при клике
                // — они появятся при соответствующем действии
                if (item.action !== 'toggleBath' && item.action !== 'toggleBed') {
                    this.spawnParticles(item.type, itemX, itemY);
                }
                this.movePetToItem(item);
                return;
            }
        }
        
        // Проверяем клик по коту
        const petX = canvas.width * room.petX;
        const petY = canvas.height * room.petY;
        const scale = this.getPetScale();
        const catRadius = 70 * scale;
        
        // Попадание по телу кота
        const dist = Math.sqrt((x - petX) ** 2 + (y - petY) ** 2);
        if (dist < catRadius) {
            // Гладим кота!
            this.petPet();
            this.triggerReaction();
            this.spawnHeartParticles(petX, petY - 120 * scale);
        }
    },

    // Система частиц для сердечек (над головой, полупрозрачные)
    spawnHeartParticles(x, y) {
        for (let i = 0; i < 6; i++) {
            const angle = -Math.PI/2 + (Math.random() - 0.5) * Math.PI * 0.8;
            const speed = 0.8 + Math.random() * 1.5;
            
            this.particles.push({
                x: x + (Math.random() - 0.5) * 60,
                y: y - 50 + (Math.random() - 0.5) * 20,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 0.5,
                life: 35 + Math.random() * 15,
                maxLife: 50,
                size: 7 + Math.random() * 5,
                type: 'heart',
                color: ['rgba(255,107,107,0.6)', 'rgba(255,105,180,0.5)', 'rgba(255,20,147,0.4)', 'rgba(255,182,193,0.6)'][Math.floor(Math.random() * 4)],
                rotation: (Math.random() - 0.5) * 0.3,
                rotSpeed: (Math.random() - 0.5) * 0.05
            });
        }
    },

    // Система частиц
    spawnParticles(type, x, y) {
        const count = 15;
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 / count) * i + Math.random() * 0.5;
            const speed = 2 + Math.random() * 4;
            const life = 40 + Math.random() * 30;
            
            let particle = {
                x: x,
                y: y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 2,
                life: life,
                maxLife: life,
                size: 4 + Math.random() * 6,
                type: type
            };
            
            // Разные параметры для разных типов
            if (type === 'foodBowl') {
                particle.color = ['#8B5A2B', '#CD853F', '#DEB887', '#A0522D'][Math.floor(Math.random() * 4)];
                particle.shape = 'circle';
                particle.vy = Math.sin(angle) * speed - 4;
            } else if (type === 'bathtub') {
                particle.color = ['rgba(135,206,250,0.8)', 'rgba(173,216,230,0.9)', 'rgba(255,255,255,0.7)', 'rgba(100,149,237,0.6)'][Math.floor(Math.random() * 4)];
                particle.shape = 'drop';
                particle.vy = Math.sin(angle) * speed - 6;
                particle.size = 3 + Math.random() * 5;
            } else if (type === 'bed') {
                particle.color = ['#FFD700', '#FFA500', '#FF69B4', '#DDA0DD', '#FFF'][Math.floor(Math.random() * 5)];
                particle.shape = 'star';
                particle.rotation = Math.random() * Math.PI * 2;
                particle.rotSpeed = (Math.random() - 0.5) * 0.2;
                particle.vy = Math.sin(angle) * speed - 3;
            }
            
            this.particles.push(particle);
        }
    },

    updateAndDrawParticles(ctx) {
        // Perf: skip the loop when no particles are queued.
        if (this.particles.length === 0) return;
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            
            // Обновляем позицию
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.15;
            p.life--;
            
            // Удаляем мёртвые частицы
            if (p.life <= 0) {
                this.particles.splice(i, 1);
                continue;
            }
            
            // Рисуем
            const alpha = p.life / p.maxLife;
            ctx.globalAlpha = alpha;
            
            if (p.shape === 'circle') {
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.shape === 'drop') {
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y - p.size);
                ctx.quadraticCurveTo(p.x + p.size, p.y, p.x, p.y + p.size * 0.6);
                ctx.quadraticCurveTo(p.x - p.size, p.y, p.x, p.y - p.size);
                ctx.fill();
            } else if (p.shape === 'star') {
                p.rotation += p.rotSpeed;
                ctx.fillStyle = p.color;
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rotation);
                this.drawStar(ctx, 0, 0, 5, p.size * alpha, p.size * alpha * 0.5);
                ctx.restore();
            } else if (p.type === 'heart') {
                p.rotation += p.rotSpeed;
                ctx.fillStyle = p.color;
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rotation);
                this.drawHeart(ctx, 0, 0, p.size * alpha);
                ctx.restore();
            }
        }
        ctx.globalAlpha = 1;
    },

    drawHeart(ctx, x, y, size) {
        ctx.beginPath();
        ctx.moveTo(x, y + size * 0.3);
        ctx.bezierCurveTo(x, y, x - size, y, x - size, y + size * 0.3);
        ctx.bezierCurveTo(x - size, y + size * 0.6, x, y + size * 0.8, x, y + size);
        ctx.bezierCurveTo(x, y + size * 0.8, x + size, y + size * 0.6, x + size, y + size * 0.3);
        ctx.bezierCurveTo(x + size, y, x, y, x, y + size * 0.3);
        ctx.fill();
    },

    drawStar(ctx, cx, cy, spikes, outerRadius, innerRadius) {
        let rot = Math.PI / 2 * 3;
        let step = Math.PI / spikes;
        
        ctx.beginPath();
        ctx.moveTo(cx, cy - outerRadius);
        for (let i = 0; i < spikes; i++) {
            ctx.lineTo(cx + Math.cos(rot) * outerRadius, cy + Math.sin(rot) * outerRadius);
            rot += step;
            ctx.lineTo(cx + Math.cos(rot) * innerRadius, cy + Math.sin(rot) * innerRadius);
            rot += step;
        }
        ctx.lineTo(cx, cy - outerRadius);
        ctx.closePath();
        ctx.fill();
    },

    // Обработка hover — только смена курсора, без drawPet()
    handleCanvasHover(x, y, canvas) {
        this.updateCursorOnly(x, y, canvas);
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

            // Save petId to localStorage so the same pet persists across reloads
            try { localStorage.setItem('demonCatPetId', this.petId); } catch (e) {}

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

    // Кормить питомца — берёт еду, через 2 секунды съедает
    async feedPet() {
        try {
            const response = await fetch(`${API_BASE}/pet/${this.petId}/feed`, {
                method: 'POST'
            });
            const data = await response.json();
            this.pet = data.pet;
            this.addNotification('Кот взял еду! 🍖', 'feed');
            this.updateUI();
            
            // Через 2 секунды съедает
            setTimeout(async () => {
                if (!this.pet || !this.pet.is_eating) return;
                try {
                    const eatResponse = await fetch(`${API_BASE}/pet/${this.petId}/eat`, {
                        method: 'POST'
                    });
                    const eatData = await eatResponse.json();
                    this.pet = eatData.pet;
                    this.addNotification('Кот съел всю еду! 😋', 'feed');
                    this.spawnParticles('foodBowl', 0, 0);
                    this.updateUI();
                } catch (e) {
                    console.error('Error eating:', e);
                }
            }, 2000);
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

    // Тоггл ванны — войти/выйти
    async toggleBath() {
        try {
            const response = await fetch(`${API_BASE}/pet/${this.petId}/bath-toggle`, {
                method: 'POST'
            });
            const data = await response.json();
            this.pet = data.pet;
            
            if (this.pet.in_bath) {
                this.addNotification('Кот залез в ванну! 🛁', 'wash');
            this.settleDropStart = performance.now();
            this.settleDropKind = 'bath';
            } else {
                this.addNotification('Кот вылез из ванны! Чистота +30 🧼', 'wash');
                this.spawnParticles('bathtub', 0, 0);
            }
            this.updateUI();
        } catch (error) {
            console.error('Error toggling bath:', error);
        }
    },

    // Тоггл кровати — лечь/встать
    async toggleBed() {
        try {
            const response = await fetch(`${API_BASE}/pet/${this.petId}/bed-toggle`, {
                method: 'POST'
            });
            const data = await response.json();
            this.pet = data.pet;
            
            if (this.pet.in_bed) {
                this.addNotification('Кот лёг спать... Zzz 💤', 'sleep');
            this.settleDropStart = performance.now();
            this.settleDropKind = 'bed';
            } else {
                this.addNotification('Кот проснулся! Энергия +20 ⚡', 'sleep');
                this.spawnParticles('bed', 0, 0);
            }
            this.updateUI();
        } catch (error) {
            console.error('Error toggling bed:', error);
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
            // updateUI вызывает drawPet() сам, не дублируем
        }, 2000);
    },

    // Обновить UI + перерисовка
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

        // Рисуем питомца (вызывается не чаще updateInterval)
        if (this._perfEnabled) this._drawCaller = "updateUI";
        this.drawPet();
    },

    // Перерисовка при смене комнаты (без setInterval, по запросу)
    // ==== Settle-drop animation (cat visibly drops into bath/bed) ====
    // Returns a single Y-offset to add when drawing the cat, while
    // settleDropKind is set. Eases out from DROP_PX -> 0 over 200ms.
    getSettleDropOffset() {
        if (!this.settleDropKind) return 0;
        const DROP_PX = 90;     // how far above its slot the cat starts
        const DUR_MS = 200;     // length of the drop
        const elapsed = performance.now() - this.settleDropStart;
        if (elapsed >= DUR_MS) {
            this.settleDropKind = null;   // one-shot cleanup
            return 0;
        }
        const t = Math.min(1, elapsed / DUR_MS);
        const eased = 1 - Math.pow(1 - t, 2);   // quadratic ease-out
        return DROP_PX * (1 - eased);          // start at +DROP_PX, end at 0
    },

    // Перерисовка при смене комнаты (без setInterval, по запросу)
    redrawPetNow() {
        if (this._perfEnabled) this._drawCaller = "redrawPetNow";
        this.drawPet();
    },

    // ===== Perf helpers =====
    // The rAF animation loop runs at ~60 fps. Event handlers
    // therefore never need to repaint synchronously: any pending
    // redraw happens within ~16 ms anyway. This stub is a safe
    // drop-in replacement for `this.drawPet()` in event code.
    requestPetDraw() {
        // Intentional no-op. Reserving for future dirty-flag use.
    },
    // Lighter overlay for the dragged item: paint only the item
    // sculpture with static (no hover) parameters — no roundRect
    // label, no measureText, no save/restore churn beyond one call.
    _drawDraggedItemOverlay(ctx, item, w, h) {
        if (!item) return;
        const cx = w * item.x;
        const cy = h * item.y;
        if (item.type === 'foodBowl') {
            this.drawFoodBowl(ctx, cx, cy, w * 0.08, false);
        } else if (item.type === 'bathtub') {
            this.drawBathtub(ctx, cx, cy, w * 0.12, false);
        } else if (item.type === 'bed') {
            this.drawBed(ctx, cx, cy, w * 0.14, false);
        }
    },

    // Tiny HUD overlay — caller breakdown for last-second window.
    _drawPerfHud(ctx, canvasW) {
        const t = this._perfTotals;
        const c = (t._1sRing || []).reduce(function (acc, k) {
            acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, { rAF: 0, redrawPetNow: 0, updateUI: 0,
             changeRoom: 0, movePetToItem: 0, leak: 0 });
        const onlyRAF = (c.redrawPetNow === 0 && c.updateUI === 0 &&
                         c.changeRoom === 0 && c.movePetToItem === 0 &&
                         c.leak === 0);
        const total = c.rAF + c.redrawPetNow + c.updateUI +
                      c.changeRoom + c.movePetToItem + c.leak;
        const pillW = 220, pillH = 80, padX = 10, padY = 8;
        const x = canvasW - pillW - 8;
        const y = 8;
        ctx.save();
        // background pill
        ctx.fillStyle = onlyRAF ? "rgba(0,180,110,0.92)" : "rgba(220,40,40,0.92)";
        ctx.fillRect(x, y, pillW, pillH);
        // title
        ctx.fillStyle = "#fff";
        ctx.font = "bold 12px monospace";
        ctx.textAlign = "left";
        ctx.fillText("PERF HUD " + (onlyRAF ? "OK" : "CHECK"), x + padX, y + padY + 12);
        // body lines
        ctx.font = "11px monospace";
        ctx.fillText("frames in 60-frame window: " + total, x + padX, y + padY + 30);
        ctx.fillText("rAF: " + c.rAF + "  leak: " + c.leak, x + padX, y + padY + 44);
        ctx.fillText("upd=" + c.updateUI + "  rnd=" + c.redrawPetNow +
                     "  cr=" + c.changeRoom + "  mi=" + c.movePetToItem,
                     x + padX, y + padY + 58);
        // tip
        ctx.font = "10px monospace";
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fillText("Disabled by default. Use ?perf=1 to enable.",
                     x + padX, y + padY + 72);
        ctx.restore();
    },

    // ===== rAF animation loop for pet canvas =====
    petAnimLoop() {
        if (!this._petAnimLoopRunning) return; // safety
        if (this._perfEnabled) this._drawCaller = "rAF";
        this.drawPet();
        this._petAnimFrame = requestAnimationFrame(() => this.petAnimLoop());
    },
    startPetAnimLoop() {
        if (this._petAnimLoopRunning) return; // idempotent
        this._petAnimLoopRunning = true;
        this._mainScreenActive = true;
        this.petAnimLoop();
    },
    stopPetAnimLoop() {
        this._petAnimLoopRunning = false;
        this._mainScreenActive = false;
        if (this._petAnimFrame) {
            cancelAnimationFrame(this._petAnimFrame);
            this._petAnimFrame = null;
        }
    },

    // ===== localStorage petId reuse =====
    async tryReuseExistingPet() {
        let stored = null;
        try { stored = localStorage.getItem('demonCatPetId'); } catch (e) { return false; }
        if (!stored) return false;
        try {
            const resp = await fetch(`${API_BASE}/pet/${stored}`);
            if (!resp.ok) return false;
            const pet = await resp.json();
            if (pet && pet.pet_id) {
                this.petId = pet.pet_id;
                this.pet = pet;
                console.log("Pet reused:", this.petId);
                return true;
            }
        } catch (e) {}
        return false;
    },

    // Только обновить курсор при hover без полной перерисовки
    updateCursorOnly(x, y, canvas) {
        const room = this.rooms[this.currentRoom];
        const prevHovered = this.hoveredItem;
        
        if (!room.item || this.drawPet) {
            // Быстрая проверка: границы кликабельности
            const item = room.item;
            const itemX = canvas.width * item.x;
            const itemY = canvas.height * item.y;
            const itemW = canvas.width * item.w;
            const itemH = canvas.height * item.h;
            
            const inside = x >= itemX - itemW/2 && x <= itemX + itemW/2 &&
                          y >= itemY - itemH/2 && y <= itemY + itemH/2;
            
            if (inside && prevHovered !== item.type) {
                this.hoveredItem = item.type;
                canvas.style.cursor = 'pointer';
                this.requestPetDraw();
            } else if (!inside && prevHovered !== null) {
                this.hoveredItem = null;
                canvas.style.cursor = 'default';
                this.requestPetDraw();
            }
            return;
        }
        
        // Без предметов — просто курсор, без drawPet()
        if (prevHovered !== null) {
            this.hoveredItem = null;
            canvas.style.cursor = 'default';
        }
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
        if (this._perfEnabled) this._drawCaller = "changeRoom";
        this.drawPet();
    },

    movePetToItem(item) {
        const room = this.rooms[this.currentRoom];
        const offsets = {
            foodBowl: [-0.10, -0.05],
            bathtub:  [-0.08, -0.05],
            bed:      [-0.10,  0.05]
        };
        const [dx, dy] = offsets[item.type] || [-0.10, -0.05];
        const tx = Math.max(0.08, Math.min(0.92, item.x + dx));
        const ty = Math.max(0.12, Math.min(0.88, item.y + dy));
        const dur = 400;
        const t0 = performance.now();
        const startX = room.petX;
        const startY = room.petY;
        const self = this;
        const step = () => {
            const t = Math.min(1, (performance.now() - t0) / dur);
            room.petX = startX + (tx - startX) * t;
            room.petY = startY + (ty - startY) * t;
            if (t < 1 && self._mainScreenActive) {
                requestAnimationFrame(step);
            } else {
                self.spawnParticles(item.type, 0, 0);
                self[item.action]();
            }
        };
        requestAnimationFrame(step);
    },

    // Рисование питомца на Canvas
    drawPet() {
        // Perf HUD: tag caller and tally.
        if (this._perfEnabled) {
            const _c = this._drawCaller || "leak";
            this._perfTotals[_c] = (this._perfTotals[_c] || 0) + 1;
            const _r = this._perfTotals._1sRing;
            const _h = this._perfTotals._1sRingHead;
            _r[_h % 60] = _c;
            this._perfTotals._1sRingHead = (_h + 1) % 60;
            this._drawCaller = null;
        }
        const canvas = document.getElementById('petCanvas');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
        // Рисуем фон комнаты
        const room = this.rooms[this.currentRoom];
        ctx.fillStyle = room.color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Рисуем элементы комнаты (ПЕРЕД питомцем, но на фоне)
        this.drawRoomElements(ctx, canvas.width, canvas.height);
        
        // Рисуем демон-кота в позиции комнаты
        const petX = canvas.width * room.petX;
        const petY = canvas.height * room.petY;
        this.drawDemonCat(ctx, petX, petY);

        // Когда предмет перетаскивают — рисуем только его поверх кота.
        // Один лёгкий проход: нет второй drawRoomElements, нет меряющего
        // hover-label. rAF-цикл всё равно перерисует кадр через ~16 ms.
        if (
            this.dragState && this.dragState.active &&
            this.dragState.type === 'item' && room.item
        ) {
            this._drawDraggedItemOverlay(ctx, room.item, canvas.width, canvas.height);
        }


        // Perf HUD overlay (top-right pill)
        if (this._perfEnabled) {
            this._drawPerfHud(ctx, canvas.width);
        }
        // Рисуем частицы поверх всего
        this.updateAndDrawParticles(ctx);
    },

    // Отрисовка элементов комнаты
    drawRoomElements(ctx, w, h) {
        const room = this.rooms[this.currentRoom];
        if (!room.item) return;
        
        const item = room.item;
        const cx = w * item.x;
        const cy = h * item.y;
        const isHovered = this.hoveredItem === item.type;
        
        ctx.save();
        
        if (item.type === 'foodBowl') {
            this.drawFoodBowl(ctx, cx, cy, w * 0.08, isHovered);
        } else if (item.type === 'bathtub') {
            this.drawBathtub(ctx, cx, cy, w * 0.12, isHovered);
        } else if (item.type === 'bed') {
            this.drawBed(ctx, cx, cy, w * 0.14, isHovered);
        }
        
        // Подсказка при hover
        if (isHovered) {
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            const textW = ctx.measureText(item.label).width + 20;
            ctx.beginPath();
            ctx.roundRect(cx - textW/2, cy - h * 0.15 - 25, textW, 24, 8);
            ctx.fill();
            ctx.fillStyle = '#333';
            ctx.fillText(item.label, cx, cy - h * 0.15 - 10);
        }
        
        ctx.restore();
    },

    // Миска с едой
    drawFoodBowl(ctx, x, y, r, hovered) {
        const bounce = hovered ? Math.sin(Date.now() / 100) * 3 : 0;
        
        // Тень
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.beginPath();
        ctx.ellipse(x, y + r * 0.8, r * 1.1, r * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // Миска (внешняя часть — тёмная)
        ctx.fillStyle = '#8B4513';
        ctx.beginPath();
        ctx.ellipse(x, y + bounce, r * 1.1, r * 0.5, 0, 0, Math.PI);
        ctx.fill();
        
        // Миска (внутренняя часть — красная)
        ctx.fillStyle = '#CC3333';
        ctx.beginPath();
        ctx.ellipse(x, y + bounce, r * 0.9, r * 0.35, 0, 0, Math.PI);
        ctx.fill();
        
        // Еда (корм — коричневые кусочки)
        ctx.fillStyle = '#8B5A2B';
        for (let i = 0; i < 5; i++) {
            ctx.beginPath();
            ctx.arc(x - r * 0.5 + i * r * 0.25, y + r * 0.1 + bounce, r * 0.12, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Подсветка при hover
        if (hovered) {
            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.ellipse(x, y + bounce, r * 1.3, r * 0.65, 0, 0, Math.PI);
            ctx.stroke();
        }
    },

    // Ванна
    drawBathtub(ctx, x, y, r, hovered) {
        const bubbleFloat = Math.sin(Date.now() / 600) * 2;
        
        // Тень
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.beginPath();
        ctx.ellipse(x, y + r * 0.9, r * 1.3, r * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // Ванна (тело — белая)
        ctx.fillStyle = '#F5F5F5';
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.2, r * 0.7, 0, 0, Math.PI);
        ctx.fill();
        ctx.strokeStyle = '#DDD';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        // Край ванны
        ctx.fillStyle = '#FFF';
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.2, r * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#CCC';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Вода (голубая)
        ctx.fillStyle = 'rgba(135, 206, 250, 0.6)';
        ctx.beginPath();
        ctx.ellipse(x, y + r * 0.1, r * 1, r * 0.45, 0, 0, Math.PI);
        ctx.fill();
        
        // Пузырьки
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        const bubbles = [
            { bx: -0.4, by: -0.2, br: 0.08 },
            { bx: -0.1, by: -0.35, br: 0.06 },
            { bx: 0.2, by: -0.25, br: 0.1 },
            { bx: 0.4, by: -0.3, br: 0.05 },
            { bx: 0.0, by: -0.15, br: 0.07 }
        ];
        bubbles.forEach(b => {
            ctx.beginPath();
            ctx.arc(x + r * b.bx, y + r * b.by + bubbleFloat, r * b.br, 0, Math.PI * 2);
            ctx.fill();
        });
        
        // Краник
        ctx.fillStyle = '#AAA';
        ctx.fillRect(x + r * 0.8, y - r * 0.8, r * 0.15, r * 0.5);
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(x + r * 0.875, y - r * 0.8, r * 0.1, 0, Math.PI * 2);
        ctx.fill();
        
        // Подсветка при hover
        if (hovered) {
            ctx.strokeStyle = '#87CEEB';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.ellipse(x, y, r * 1.4, r * 0.85, 0, 0, Math.PI);
            ctx.stroke();
        }
    },

    // Кровать
    drawBed(ctx, x, y, r, hovered) {
        const pillowBounce = Math.sin(Date.now() / 1000) * 1;
        
        // Тень
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.beginPath();
        ctx.ellipse(x, y + r * 0.85, r * 1.4, r * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // Каркас кровати (деревянный)
        ctx.fillStyle = '#8B4513';
        ctx.beginPath();
        ctx.roundRect(x - r * 1.3, y - r * 0.3, r * 2.6, r * 1, 8);
        ctx.fill();
        
        // Матрас (синий)
        ctx.fillStyle = '#4A90D9';
        ctx.beginPath();
        ctx.roundRect(x - r * 1.15, y - r * 0.2, r * 2.3, r * 0.75, 6);
        ctx.fill();
        
        // Подушка (белая)
        ctx.fillStyle = '#FFF';
        ctx.beginPath();
        ctx.ellipse(x - r * 0.7, y - r * 0.1 + pillowBounce, r * 0.35, r * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#EEE';
        ctx.lineWidth = 1;
        ctx.stroke();
        
        // Одеяло (тёмно-синее)
        ctx.fillStyle = '#2C5F8A';
        ctx.beginPath();
        ctx.roundRect(x - r * 0.2, y - r * 0.15, r * 1.4, r * 0.65, 5);
        ctx.fill();
        
        // Узор на одеяле
        ctx.strokeStyle = '#3A7AB5';
        ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(x + r * 0.0 + i * r * 0.4, y);
            ctx.lineTo(x + r * 0.0 + i * r * 0.4, y + r * 0.4);
            ctx.stroke();
        }
        
        // Изголовье
        ctx.fillStyle = '#6B3410';
        ctx.beginPath();
        ctx.roundRect(x - r * 1.3, y - r * 0.5, r * 0.2, r * 0.8, [4, 0, 0, 4]);
        ctx.fill();
        
        // Подсветка при hover
        if (hovered) {
            ctx.strokeStyle = '#B19CD9';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.roundRect(x - r * 1.45, y - r * 0.55, r * 2.9, r * 1.3, 10);
            ctx.stroke();
        }
    },

    // Функция для рисования кота (3 слоя)
    drawDemonCat(ctx, x, y) {
        const scale = this.getPetScale();
        const breathOffset = Math.sin(Date.now() / 800) * 3;
        const tailSwing = Math.sin(Date.now() / 500) * 15;
        
        // Проверяем реакцию
        const now = Date.now();
        let reaction = null;
        if (this.catReaction && now < this.reactionEndTime) {
            reaction = this.catReaction;
        } else {
            this.catReaction = null;
        }
        const reactionProgress = reaction ? (now - (this.reactionEndTime - 1500)) / 1500 : 0;
        
        // ===== СПЕЦИАЛЬНЫЕ АНИМАЦИИ =====
        // Оседание: при входе в ванну/кровать виртуально поднимаем кота,
        // затем за 200 ms ease-out опускаем обратно — выглядит «упал в ванну/кровать».
        const dropOffset = (this.pet && (this.pet.in_bath || this.pet.in_bed))
            ? this.getSettleDropOffset() : 0;
        // Если кот в ванне — рисуем только голову + пузырьки
        if (this.pet && this.pet.in_bath) {
            return this.drawCatInBath(ctx, x, y + dropOffset, scale, now, reaction);
        }
        
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
        
        // Верхние лапы (руки) с анимацией реакции
        ctx.fillStyle = '#e74c3c';
        const pawWave = reaction === 'angry' ? Math.sin(now / 80) * 15 * scale : 0;
        const pawDown = reaction === 'cute' ? 10 * scale : 0;
        // Левая рука
        ctx.beginPath();
        ctx.ellipse(x - 65 * scale, y - 10 * scale + breathOffset + pawDown, 18 * scale, 28 * scale, -0.4 + pawWave * 0.02, 0, Math.PI * 2);
        ctx.fill();
        // Пальцы левой руки
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.ellipse(
                x - 70 * scale + i * 8 * scale, 
                y - 35 * scale + breathOffset + pawDown,
                5 * scale, 8 * scale, pawWave * 0.05, 0, Math.PI * 2
            );
            ctx.fill();
        }
        // Правая рука
        ctx.beginPath();
        ctx.ellipse(x + 65 * scale, y - 10 * scale + breathOffset + pawDown, 18 * scale, 28 * scale, 0.4 - pawWave * 0.02, 0, Math.PI * 2);
        ctx.fill();
        // Пальцы правой руки
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.ellipse(
                x + 60 * scale + i * 8 * scale, 
                y - 35 * scale + breathOffset + pawDown,
                5 * scale, 8 * scale, -pawWave * 0.05, 0, Math.PI * 2
            );
            ctx.fill();
        }
        
        // Голова (круглая)
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.arc(x, y - 55 * scale + breathOffset, 55 * scale, 0, Math.PI * 2);
        ctx.fill();
        
        // Ушки (кошачьи, острые) с анимацией
        ctx.fillStyle = '#e74c3c';
        const earFlop = reaction === 'cute' ? 15 * scale : 0; // Уши прижимаются
        const earUp = reaction === 'angry' ? -10 * scale : 0; // Уши стоят
        // Левое ухо
        ctx.beginPath();
        ctx.moveTo(x - 45 * scale, y - 80 * scale + breathOffset);
        ctx.lineTo(x - 25 * scale, y - 120 * scale + breathOffset + earUp - earFlop);
        ctx.lineTo(x - 10 * scale, y - 75 * scale + breathOffset);
        ctx.closePath();
        ctx.fill();
        // Правое ухо
        ctx.beginPath();
        ctx.moveTo(x + 45 * scale, y - 80 * scale + breathOffset);
        ctx.lineTo(x + 25 * scale, y - 120 * scale + breathOffset + earUp - earFlop);
        ctx.lineTo(x + 10 * scale, y - 75 * scale + breathOffset);
        ctx.closePath();
        ctx.fill();
        
        // Краснеющие щёки при милой реакции
        if (reaction === 'cute') {
            ctx.fillStyle = 'rgba(255, 150, 150, 0.5)';
            ctx.beginPath();
            ctx.ellipse(x - 40 * scale, y - 45 * scale + breathOffset, 12 * scale, 8 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(x + 40 * scale, y - 45 * scale + breathOffset, 12 * scale, 8 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        
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
        
        // Глаза с учётом реакции
        const eyeY = y - 60 * scale + breathOffset;
        
        if (reaction === 'angry') {
            // Злые глаза (нахмуренные)
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 3 * scale;
            // Брови
            ctx.beginPath();
            ctx.moveTo(x - 28 * scale, eyeY - 8 * scale);
            ctx.lineTo(x - 12 * scale, eyeY - 4 * scale);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x + 28 * scale, eyeY - 8 * scale);
            ctx.lineTo(x + 12 * scale, eyeY - 4 * scale);
            ctx.stroke();
            // Глаза
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.ellipse(x - 18 * scale, eyeY + 2 * scale, 9 * scale, 7 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(x + 18 * scale, eyeY + 2 * scale, 9 * scale, 7 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
        } else if (reaction === 'cute') {
            // Милые закрытые глазки (^^)
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 3 * scale;
            ctx.beginPath();
            ctx.arc(x - 18 * scale, eyeY, 10 * scale, Math.PI + 0.3, -0.3);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x + 18 * scale, eyeY, 10 * scale, Math.PI + 0.3, -0.3);
            ctx.stroke();
        } else if (reaction === 'purr') {
            // Прищуренные глазки (довольные)
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.ellipse(x - 18 * scale, eyeY, 8 * scale, 4 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(x + 18 * scale, eyeY, 8 * scale, 4 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
        } else if (this.pet.mood > 70) {
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
        
        // Рот с учётом реакции
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 3 * scale;
        ctx.beginPath();
        
        if (reaction === 'angry') {
            // Злой рот (открытый)
            ctx.moveTo(x - 12 * scale, y - 43 * scale + breathOffset);
            ctx.lineTo(x, y - 38 * scale + breathOffset);
            ctx.lineTo(x + 12 * scale, y - 43 * scale + breathOffset);
            // Зубки
            ctx.moveTo(x - 5 * scale, y - 43 * scale + breathOffset);
            ctx.lineTo(x - 3 * scale, y - 38 * scale + breathOffset);
            ctx.moveTo(x + 5 * scale, y - 43 * scale + breathOffset);
            ctx.lineTo(x + 3 * scale, y - 38 * scale + breathOffset);
        } else if (reaction === 'cute') {
            // Милая ухмылка 'w'
            ctx.moveTo(x - 10 * scale, y - 43 * scale + breathOffset);
            ctx.quadraticCurveTo(x - 5 * scale, y - 38 * scale + breathOffset, x, y - 43 * scale + breathOffset);
            ctx.quadraticCurveTo(x + 5 * scale, y - 38 * scale + breathOffset, x + 10 * scale, y - 43 * scale + breathOffset);
        } else if (reaction === 'purr') {
            // Довольная улыбка с язычком
            ctx.arc(x, y - 45 * scale + breathOffset, 10 * scale, 0.3, Math.PI - 0.3);
            ctx.fill();
            ctx.fillStyle = '#FF9999';
            ctx.beginPath();
            ctx.ellipse(x, y - 40 * scale + breathOffset, 5 * scale, 3 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
        } else if (this.pet.mood > 50) {
            ctx.arc(x, y - 45 * scale + breathOffset, 10 * scale, 0.3, Math.PI - 0.3);
        } else if (this.pet.mood < 30) {
            ctx.arc(x, y - 38 * scale + breathOffset, 10 * scale, Math.PI + 0.3, -0.3);
        } else {
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
        
        // Буква «Мяу» при реакции
        if (reaction && reactionProgress < 0.5) {
            const meowAlpha = 1 - reactionProgress * 2;
            ctx.globalAlpha = meowAlpha;
            ctx.fillStyle = reaction === 'angry' ? '#FF4444' : reaction === 'cute' ? '#FF69B4' : '#888';
            ctx.font = `bold ${18 * scale}px Arial`;
            ctx.textAlign = 'center';
            const meowText = reaction === 'purr' ? 'мурр~' : reaction === 'angry' ? 'ФРРР!' : 'мяу~';
            ctx.fillText(meowText, x + 60 * scale, y - 90 * scale + breathOffset - reactionProgress * 30);
            ctx.globalAlpha = 1;
        }
        
        // Спальный пузырь (кот в кровати или мало энергии)
        if (this.pet.in_bed || this.pet.energy < 30) {
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

    // Специальная отрисовка: кот в ванне (только голова + пузырьки)
    drawCatInBath(ctx, x, y, scale, now, reaction) {
        const waterLevel = y + 15 * scale;  // уровень воды — чуть ниже головы
        const breath = Math.sin(now / 800) * 2;
        
        // === ВОДА ===
        ctx.save();
        
        // Водная гладь (полупрозрачная) над телом
        const grad = ctx.createLinearGradient(x - 80 * scale, waterLevel, x + 80 * scale, waterLevel + 60 * scale);
        grad.addColorStop(0, 'rgba(100, 200, 255, 0.6)');
        grad.addColorStop(0.5, 'rgba(135, 206, 250, 0.7)');
        grad.addColorStop(1, 'rgba(100, 200, 255, 0.6)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(x, waterLevel + 25 * scale, 80 * scale, 30 * scale, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // Блик на воде (светлая полоса)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.ellipse(x - 15 * scale, waterLevel + 15 * scale, 40 * scale, 5 * scale, 0.2, 0, Math.PI * 2);
        ctx.fill();
        
        // === ГОЛОВА (над водой) ===
        // Голова — круг
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        // === КОШАЧЬИ ЧАСТИ В ВАННЕ (торс выглядывает над водой + лапы держат бортик) ===
        // Торсовая часть (верхняя половина тела видна над уровнем воды)
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.ellipse(x, y + 8 * scale, 56 * scale, 18 * scale, 0, 0, Math.PI * 2);
        ctx.fill();

        // Животик (светло-розовый, между торсом и бортиком)
        ctx.fillStyle = '#ff9999';
        ctx.beginPath();
        ctx.ellipse(x, y + 12 * scale, 40 * scale, 10 * scale, 0, 0, Math.PI * 2);
        ctx.fill();

        // Передние лапы на бортике ванны (клешни симметрично)
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.ellipse(x - 50 * scale, y - 18 * scale, 14 * scale, 22 * scale, -0.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(x + 50 * scale, y - 18 * scale, 14 * scale, 22 * scale, 0.25, 0, Math.PI * 2);
        ctx.fill();

        // Пальчики на передних лапах
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.ellipse(x - 56 * scale + i * 6 * scale, y - 38 * scale, 4 * scale, 6 * scale, -0.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(x + 44 * scale + i * 6 * scale, y - 38 * scale, 4 * scale, 6 * scale, 0.2, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.arc(x, y - 55 * scale + breath, 55 * scale, 0, Math.PI * 2);
        ctx.fill();
        
        // Уши
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.moveTo(x - 45 * scale, y - 80 * scale + breath);
        ctx.lineTo(x - 25 * scale, y - 120 * scale + breath);
        ctx.lineTo(x - 10 * scale, y - 75 * scale + breath);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x + 45 * scale, y - 80 * scale + breath);
        ctx.lineTo(x + 25 * scale, y - 120 * scale + breath);
        ctx.lineTo(x + 10 * scale, y - 75 * scale + breath);
        ctx.closePath();
        ctx.fill();
        
        // Глаза счастливые (закрытые ^^)
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 3 * scale;
        ctx.beginPath();
        ctx.arc(x - 18 * scale, y - 60 * scale + breath, 10 * scale, Math.PI + 0.3, -0.3);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x + 18 * scale, y - 60 * scale + breath, 10 * scale, Math.PI + 0.3, -0.3);
        ctx.stroke();
        
        // Ротик (довольная улыбка)
        ctx.beginPath();
        ctx.arc(x, y - 45 * scale + breath, 10 * scale, 0.2, Math.PI - 0.2);
        ctx.stroke();
        
        // Нос
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.moveTo(x, y - 50 * scale + breath);
        ctx.lineTo(x - 5 * scale, y - 45 * scale + breath);
        ctx.lineTo(x + 5 * scale, y - 45 * scale + breath);
        ctx.closePath();
        ctx.fill();
        
        // Щёчки (розовые)
        ctx.fillStyle = 'rgba(255, 150, 150, 0.4)';
        ctx.beginPath();
        ctx.ellipse(x - 40 * scale, y - 45 * scale + breath, 12 * scale, 8 * scale, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(x + 40 * scale, y - 45 * scale + breath, 12 * scale, 8 * scale, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // Полоски на щеках
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 3 * scale;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(x - 55 * scale, y - 55 * scale + i * 12 * scale + breath);
            ctx.lineTo(x - 40 * scale, y - 55 * scale + i * 12 * scale + breath);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x + 55 * scale, y - 55 * scale + i * 12 * scale + breath);
            ctx.lineTo(x + 40 * scale, y - 55 * scale + i * 12 * scale + breath);
            ctx.stroke();
        }
        
        // === ПУЗЫРЬКИ ===
        const bubbleTime = now / 400;
        for (let i = 0; i < 8; i++) {
            const bx = x + (Math.sin(bubbleTime + i * 2.3)) * 45 * scale;
            const by = waterLevel + 30 * scale - (now % 3000) / 3000 * 80 * scale - i * 15 * scale;
            const br = (4 + Math.sin(bubbleTime + i * 1.7) * 2) * scale;
            
            // Круговой сдвиг для реалистичности
            const offsetX = Math.sin(bubbleTime * 0.5 + i) * 10 * scale;
            
            ctx.fillStyle = 'rgba(200, 230, 255, ' + (0.3 + Math.sin(bubbleTime + i) * 0.15) + ')';
            ctx.beginPath();
            ctx.arc(bx + offsetX, ((by % (waterLevel + 20)) ), Math.max(1, br), 0, Math.PI * 2);
            ctx.fill();
            
            // Блик пузырька
            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.beginPath();
            ctx.arc(bx + offsetX - br * 0.3, ((by % (waterLevel + 20))) - br * 0.3, br * 0.3, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Пенный воротник вокруг шеи
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI + Math.sin(now / 600 + i) * 0.3;
            const fx = x + Math.cos(angle) * 55 * scale;
            const fy = waterLevel - 5 * scale + Math.sin(now / 500 + i * 1.5) * 5 * scale;
            ctx.beginPath();
            ctx.arc(fx, fy, (8 + Math.sin(now / 700 + i * 2) * 3) * scale, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.restore();
    },

    // Специальная отрисовка: кот в кровати (спящая поза)
    drawCatInBed(ctx, x, y, scale, now, reaction) {
        const breath = Math.sin(now / 1200) * 2;
        const zzzFloat = Math.sin(now / 600) * 8;
        
        ctx.save();
        
        // === ТЕЛО (свернулось калачиком) ===
        // Спящее тело — широкая эллиптическая форма
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.ellipse(x + breath, y + 10 * scale, 75 * scale, 35 * scale, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // Животик
        ctx.fillStyle = '#ff9999';
        ctx.beginPath();
        ctx.ellipse(x + 5 * scale + breath, y + 18 * scale, 45 * scale, 20 * scale, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // === ПОДУШКА (под головой) ===
        ctx.fillStyle = '#FFF';
        ctx.beginPath();
        ctx.ellipse(x - 50 * scale, y - 5 * scale + breath, 35 * scale, 20 * scale, -0.3, 0, Math.PI * 2);
        ctx.fill();
        
        // === ХВОСТ (свёрнутый вокруг тела) ===
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 12 * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.ellipse(x + 10 * scale + breath, y + 15 * scale, 85 * scale, 30 * scale, 0.3, 0, Math.PI);
        ctx.stroke();
        
        // === ГОЛОВА (на подушке) ===
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.arc(x - 50 * scale, y - 15 * scale + breath, 45 * scale, 0, Math.PI * 2);
        ctx.fill();
        
        // Ушки (расслабленные, чуть прижаты)
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.moveTo(x - 80 * scale, y - 35 * scale + breath);
        ctx.lineTo(x - 65 * scale, y - 60 * scale + breath);
        ctx.lineTo(x - 55 * scale, y - 35 * scale + breath);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x - 25 * scale, y - 35 * scale + breath);
        ctx.lineTo(x - 35 * scale, y - 60 * scale + breath);
        ctx.lineTo(x - 15 * scale, y - 35 * scale + breath);
        ctx.closePath();
        ctx.fill();
        
        // Глаза закрытые (короткие чёрточки)
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 3 * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - 60 * scale, y - 20 * scale + breath);
        ctx.lineTo(x - 50 * scale, y - 18 * scale + breath);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 42 * scale, y - 20 * scale + breath);
        ctx.lineTo(x - 32 * scale, y - 18 * scale + breath);
        ctx.stroke();
        
        // Нос
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.moveTo(x - 46 * scale, y - 12 * scale + breath);
        ctx.lineTo(x - 49 * scale, y - 8 * scale + breath);
        ctx.lineTo(x - 43 * scale, y - 8 * scale + breath);
        ctx.closePath();
        ctx.fill();
        
        // Улыбка (довольная)
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.arc(x - 46 * scale, y - 5 * scale + breath, 7 * scale, 0.2, Math.PI - 0.2);
        ctx.stroke();
        
        // === ОДЕЯЛО ===
        ctx.fillStyle = '#2C5F8A';
        ctx.beginPath();
        ctx.ellipse(x + 30 * scale + breath, y + 20 * scale, 50 * scale, 20 * scale, 0.2, 0, Math.PI);
        ctx.fill();
        ctx.strokeStyle = '#3A7AB5';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(x + i * 25 * scale, y + 10 * scale);
            ctx.lineTo(x + i * 25 * scale, y + 30 * scale);
            ctx.stroke();
        }
        
        // === Zzz АНИМАЦИЯ ===
        ctx.fillStyle = 'rgba(200, 200, 255, 0.7)';
        ctx.font = 'bold ' + (22 * scale) + 'px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        const zzzAlpha = 0.5 + Math.sin(now / 500) * 0.3;
        ctx.globalAlpha = zzzAlpha;
        
        const zzzOffset = Math.sin(now / 800) * 3;
        ctx.fillText('Z', x - 5 * scale + zzzOffset, y - 80 * scale + zzzFloat);
        ctx.font = 'bold ' + (28 * scale) + 'px Arial';
        ctx.fillText('z', x + 15 * scale + zzzOffset, y - 100 * scale + zzzFloat * 1.3);
        ctx.font = 'bold ' + (34 * scale) + 'px Arial';
        ctx.fillText('z', x + 40 * scale + zzzOffset, y - 125 * scale + zzzFloat * 1.6);
        
        // Маленькие Zzz пузырьки
        ctx.font = 'bold ' + (14 * scale) + 'px Arial';
        ctx.fillStyle = 'rgba(200, 200, 255, ' + (0.3 + Math.sin(now / 400) * 0.2) + ')';
        ctx.fillText('z', x - 20 * scale, y - 65 * scale + Math.sin(now / 600 + 1) * 5);
        ctx.fillText('z', x + 30 * scale, y - 150 * scale + Math.sin(now / 700 + 2) * 6);
        
        ctx.globalAlpha = 1;
        ctx.restore();
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

    // ===== СКЕТЧБУК =====
    sketchPages: [],
    currentPageIndex: 0,
    isFlipping: false,
    
    // Навигация на скетчбук
    goToSketch() {
        this.switchScreen('sketchScreen');
        this.loadNotebookPages();
    },

    // Загрузить страницы блокнота
    async loadNotebookPages() {
        try {
            const response = await fetch(`${API_BASE}/sketches/${this.petId}`);
            const data = await response.json();
            const rawList = Array.isArray(data) ? data : (data.sketches || []);
            // Persistence fix: backend may return imageData / image_data /
            // dataUrl — normalize to imageData so renderSinglePage finds it.
            this.sketchPages = rawList.map(function (s) {
                const img = s.imageData || s.image_data || s.dataUrl || s.data_url || '';
                return Object.assign({}, s, { imageData: img });
            });
            this.currentPageIndex = 0;
            this.renderNotebookPage();
        } catch (error) {
            console.error('Error loading notebook pages:', error);
            this.sketchPages = [];
            this.renderNotebookPage();
        }
    },

    // Отрисовать две страницы блокнота
    renderNotebookPage() {
        const leftCanvas = document.getElementById('leftCanvas');
        const rightCanvas = document.getElementById('rightCanvas');
        const leftLabel = document.getElementById('leftLabel');
        const rightLabel = document.getElementById('rightLabel');
        const leftDate = document.getElementById('leftDate');
        const rightDate = document.getElementById('rightDate');
        const pagesInfo = document.getElementById('pagesInfo');
        const prevBtn = document.querySelector('.notebook-nav.prev');
        const nextBtn = document.querySelector('.notebook-nav.next');
        
        this.renderSinglePage(leftCanvas, leftLabel, leftDate, this.currentPageIndex);
        this.renderSinglePage(rightCanvas, rightLabel, rightDate, this.currentPageIndex + 1);
        
        const total = this.sketchPages.length;
        const displayPage = total > 0 ? this.currentPageIndex + 1 : 0;
        const totalPages = total > 0 ? Math.ceil(total / 2) : 0;
        pagesInfo.textContent = total > 0 ? `Страница ${Math.ceil(displayPage / 2)} / ${totalPages}` : 'Нет страниц';
        
        prevBtn.disabled = this.currentPageIndex <= 0;
        nextBtn.disabled = this.currentPageIndex >= total - 1;
    },

    renderSinglePage(canvas, labelEl, dateEl, pageIndex) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        
        // Пустая страница
        ctx.fillStyle = '#fffeff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Декоративная рамка страницы
        ctx.strokeStyle = '#e8e0d0';
        ctx.lineWidth = 1;
        ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
        
        if (!this.sketchPages[pageIndex]) {
            ctx.fillStyle = '#ddd';
            ctx.font = '18px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (pageIndex === 0) {
                ctx.fillText('➕ Новая страница', canvas.width / 2, canvas.height / 2);
            }
            labelEl.textContent = pageIndex === 0 ? '— пусто —' : '';
            dateEl.textContent = '';
            return;
        }
        
        const page = this.sketchPages[pageIndex];
        const img = new Image();
        img.onload = () => {
            const pad = 15;
            const maxW = canvas.width - pad * 2;
            const maxH = canvas.height - pad * 2;
            const scale = Math.min(maxW / img.width, maxH / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            const x = (canvas.width - w) / 2;
            const y = (canvas.height - h) / 2;
            
            // Мягкая тень
            ctx.shadowColor = 'rgba(0,0,0,0.1)';
            ctx.shadowBlur = 8;
            ctx.shadowOffsetX = 2;
            ctx.shadowOffsetY = 2;
            ctx.drawImage(img, x, y, w, h);
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            
            // Рамка
        };
        img.src = page.imageData;
        
        labelEl.textContent = page.title || 'Без названия';
        dateEl.textContent = page.created_at
            ? new Date(page.created_at).toLocaleDateString('ru-RU')
            : '';
    },

    // Перелистывание — анимируем правую/левую страницу
    flipPage(newIndex) {
        if (this.isFlipping) return;
        this.isFlipping = true;
        
        const direction = newIndex > this.currentPageIndex ? 'next' : 'prev';
        const rightPageEl = document.getElementById('rightPage');
        const leftPageEl = document.getElementById('leftPage');
        
        rightPageEl.classList.remove('flip-out');
        leftPageEl.classList.remove('flip-out');
        
        void rightPageEl.offsetWidth;
        void leftPageEl.offsetWidth;
        
        if (direction === 'next') {
            rightPageEl.classList.add('flip-out');
        } else {
            leftPageEl.classList.add('flip-out');
        }
        
        setTimeout(() => {
            this.currentPageIndex = newIndex;
            this.renderNotebookPage();
            rightPageEl.classList.remove('flip-out');
            leftPageEl.classList.remove('flip-out');
            this.isFlipping = false;
        }, 500);
    },

    nextPage() {
        if (this.currentPageIndex < this.sketchPages.length - 1) {
            this.flipPage(this.currentPageIndex + 1);
        }
    },

    prevPage() {
        if (this.currentPageIndex > 0) {
            this.flipPage(this.currentPageIndex - 1);
        }
    },

    // Новая страница из блокнота
    newSketchFromNotebook() {
        this.currentSketchId = null;
        this.editor = new DrawingEditor();
        this.switchScreen('editorScreen');
    },

    // Редактировать текущую страницу
    editCurrentPage() {
        if (!this.sketchPages[this.currentPageIndex]) return;
        const page = this.sketchPages[this.currentPageIndex];
        this.currentSketchId = page.id;
        this.editor = new DrawingEditor();
        this.editor.loadImage(page.imageData);
        this.switchScreen('editorScreen');
    },

    // Удалить текущую страницу
    async deleteCurrentPage() {
        if (!this.sketchPages[this.currentPageIndex]) return;
        if (!confirm('Удалить эту страницу?')) return;
        
        const page = this.sketchPages[this.currentPageIndex];
        try {
            await fetch(`${API_BASE}/sketches/${this.petId}/${page.id}`, { method: 'DELETE' });
            if (this.currentPageIndex >= this.sketchPages.length - 1 && this.currentPageIndex > 0) {
                this.currentPageIndex--;
            }
            await this.loadNotebookPages();
            this.addNotification('Страница удалена 🗑️', 'info');
        } catch (error) {
            console.error('Error deleting page:', error);
        }
    },

    // Скачать текущую страницу
    exportCurrentPage() {
        if (!this.sketchPages[this.currentPageIndex]) return;
        const page = this.sketchPages[this.currentPageIndex];
        const link = document.createElement('a');
        link.href = page.imageData;
        link.download = (page.title || 'sketch') + '.png';
        link.click();
        this.addNotification('Скачано! 📥', 'success');
    },

    // Вернуться из редактора в блокнот
    backToSketchList() {
        this.switchScreen('sketchScreen');
        this.loadNotebookPages();
    },

    // ===== МИНИ-ИГРЫ =====
    currentGame: null,
    gameScore: 0,
    gameAnimFrame: null,
    
    // Вернуться в главное меню
    backToMain() {
        if (this.gameAnimFrame) {
            cancelAnimationFrame(this.gameAnimFrame);
            this.gameAnimFrame = null;
        }
        this.switchScreen('mainScreen');
    },

    // Перейти к мини-играм
    goToMinigames() {
        this.switchScreen('minigamesScreen');
    },

    // Выйти из мини-игры
    exitMinigame() {
        if (this.gameAnimFrame) {
            cancelAnimationFrame(this.gameAnimFrame);
            this.gameAnimFrame = null;
        }
        this.currentGame = null;
        this.switchScreen('minigamesScreen');
    },

    // Запустить мини-игру
    startMinigame(gameName) {
        this.gameScore = 0;
        this.currentGame = gameName;
        document.getElementById('gameScore').textContent = '0';
        if (gameName === 'hellfire' || gameName === 'nonstop') {
            // HELLFIRE BALLS owns its own #hellfireScreen — skip shared gameScreen
            document.getElementById('gameTitle').textContent = '🔥 HELLFIRE BALLS';
            if (!this._hellfire) this._hellfire = new HellfireBallsGame(this);
            this._hellfire.start();
            return;
        }
        this.switchScreen('gameScreen');
        if (gameName === 'sudoku') {
            document.getElementById('gameTitle').textContent = '🔢 Судоку';
            this.initSudoku();
        } else if (gameName === 'chess') {
            document.getElementById('gameTitle').textContent = '♟️ Шахматы';
            this.initChess();
        }
    },

    updateScore(points) {
        this.gameScore += points;
        document.getElementById('gameScore').textContent = this.gameScore;
    },

    // ===== СУДОКУ =====
    sudokuBoard: [],
    sudokuSolution: [],
    sudokuSelected: null,
    
    initSudoku() {
        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 450;
        canvas.height = 450;
        
        // Генерируем решение
        this.sudokuSolution = this.generateSudoku();
        
        // Убираем цифры для головоломки
        this.sudokuBoard = this.sudokuSolution.map(row => [...row]);
        const cellsToRemove = 40;
        let removed = 0;
        while (removed < cellsToRemove) {
            const r = Math.floor(Math.random() * 9);
            const c = Math.floor(Math.random() * 9);
            if (this.sudokuBoard[r][c] !== 0) {
                this.sudokuBoard[r][c] = 0;
                removed++;
            }
        }
        
        this.sudokuSelected = null;
        this.drawSudoku(ctx);
        
        canvas.onclick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const x = (e.clientX - rect.left) * scaleX;
            const y = (e.clientY - rect.top) * scaleY;
            const col = Math.floor(x / 50);
            const row = Math.floor(y / 50);
            if (row >= 0 && row < 9 && col >= 0 && col < 9) {
                this.sudokuSelected = { row, col };
                this.drawSudoku(ctx);
            }
        };
        
        document.onkeydown = (e) => {
            if (!this.sudokuSelected || this.currentGame !== 'sudoku') return;
            const { row, col } = this.sudokuSelected;
            const num = parseInt(e.key);
            if (num >= 1 && num <= 9) {
                // Проверяем что ячейка была пустой (нельзя менять заданные)
                const original = this.generateSudoku();
                if (this.sudokuBoard[row][col] === 0 || this.sudokuBoard[row][col] !== this.sudokuSolution[row][col]) {
                    this.sudokuBoard[row][col] = num;
                    if (num === this.sudokuSolution[row][col]) {
                        this.updateScore(10);
                    } else {
                        this.updateScore(-5);
                    }
                    this.drawSudoku(ctx);
                    this.checkSudokuWin();
                }
            } else if (e.key === 'Backspace' || e.key === 'Delete') {
                if (this.sudokuBoard[row][col] !== this.sudokuSolution[row][col]) {
                    this.sudokuBoard[row][col] = 0;
                    this.drawSudoku(ctx);
                }
            }
        };
        
        // Кнопка новой игры
        document.getElementById('gameControls').innerHTML =
            '<button class="game-control-btn" onclick="game.initSudoku()">🔄 Новая игра</button>';
    },

    generateSudoku() {
        // Простая генерация судоку
        const board = Array(9).fill(null).map(() => Array(9).fill(0));
        
        const isValid = (board, row, col, num) => {
            for (let i = 0; i < 9; i++) {
                if (board[row][i] === num) return false;
                if (board[i][col] === num) return false;
            }
            const boxRow = Math.floor(row / 3) * 3;
            const boxCol = Math.floor(col / 3) * 3;
            for (let i = boxRow; i < boxRow + 3; i++) {
                for (let j = boxCol; j < boxCol + 3; j++) {
                    if (board[i][j] === num) return false;
                }
            }
            return true;
        };
        
        const solve = (board) => {
            for (let row = 0; row < 9; row++) {
                for (let col = 0; col < 9; col++) {
                    if (board[row][col] === 0) {
                        const nums = [1,2,3,4,5,6,7,8,9].sort(() => Math.random() - 0.5);
                        for (const num of nums) {
                            if (isValid(board, row, col, num)) {
                                board[row][col] = num;
                                if (solve(board)) return true;
                                board[row][col] = 0;
                            }
                        }
                        return false;
                    }
                }
            }
            return true;
        };
        
        solve(board);
        return board;
    },

    drawSudoku(ctx) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        
        const cellSize = 50;
        
        for (let row = 0; row < 9; row++) {
            for (let col = 0; col < 9; col++) {
                const x = col * cellSize;
                const y = row * cellSize;
                
                // Фон выделенной ячейки
                if (this.sudokuSelected && this.sudokuSelected.row === row && this.sudokuSelected.col === col) {
                    ctx.fillStyle = '#BBDEFB';
                    ctx.fillRect(x, y, cellSize, cellSize);
                } else if ((Math.floor(row/3) + Math.floor(col/3)) % 2 === 0) {
                    ctx.fillStyle = '#f5f5f5';
                    ctx.fillRect(x, y, cellSize, cellSize);
                }
                
                // Рамка
                ctx.strokeStyle = '#333';
                ctx.lineWidth = (row % 3 === 0 && col % 3 === 0) ? 3 : 1;
                ctx.strokeRect(x, y, cellSize, cellSize);
                
                // Число
                if (this.sudokuBoard[row][col] !== 0) {
                    const isGiven = this.sudokuBoard[row][col] === this.sudokuSolution[row][col] && this.sudokuBoard[row][col] !== 0;
                    // Проверяем было ли задано изначально
                    ctx.fillStyle = '#333';
                    ctx.font = 'bold 24px Arial';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(this.sudokuBoard[row][col], x + cellSize/2, y + cellSize/2);
                }
            }
        }
    },

    checkSudokuWin() {
        for (let row = 0; row < 9; row++) {
            for (let col = 0; col < 9; col++) {
                if (this.sudokuBoard[row][col] !== this.sudokuSolution[row][col]) return;
            }
        }
        this.addNotification('🎉 Судоку решено! Отлично!', 'success');
    },

    // ===== ШАХМАТЫ =====
    chessBoard: [],
    chessSelected: null,
    chessTurn: 'white',
    chessPossibleMoves: [],
    chessDifficulty: 'easy',
    chessAIDepth: 1,
    
    // Цвета фигур по референсу
    chessColors: {
        white: { body: '#d8c8f0', light: '#e8d8ff', dark: '#b8a0d8', accent: '#9878b8', eyes: '#555', ear: '#c0a8e0' },
        black: { body: '#3a2a4a', light: '#5a4a6a', dark: '#2a1a3a', accent: '#1a0a2a', eyes: '#ddd', ear: '#4a3a5a' }
    },
    
    initChess() {
        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 480;
        canvas.height = 480;
        
        this.chessBoard = [
            ['♜','♞','♝','♛','♚','♝','♞','♜'],
            ['♟','♟','♟','♟','♟','♟','♟','♟'],
            ['','','','','','','',''],
            ['','','','','','','',''],
            ['','','','','','','',''],
            ['','','','','','','',''],
            ['♙','♙','♙','♙','♙','♙','♙','♙'],
            ['♖','♘','♗','♕','♔','♗','♘','♖']
        ];
        this.chessSelected = null;
        this.chessTurn = 'white';
        this.chessPossibleMoves = [];
        this.drawChess(ctx);
        
        canvas.onclick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const x = (e.clientX - rect.left) * scaleX;
            const y = (e.clientY - rect.top) * scaleY;
            const col = Math.floor(x / 60);
            const row = Math.floor(y / 60);
            if (row >= 0 && row < 8 && col >= 0 && col < 8) {
                this.handleChessClick(row, col, ctx);
            }
        };
        
        document.getElementById('gameControls').innerHTML =
            '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;align-items:center;">' +
            '<button class="game-control-btn" onclick="game.chessSetDifficulty(\"easy\")" style="' + (this.chessDifficulty==='easy'?'background:#2ecc71;':'') + '">🐱 Легко</button>' +
            '<button class="game-control-btn" onclick="game.chessSetDifficulty(\"medium\")" style="' + (this.chessDifficulty==='medium'?'background:#f39c12;':'') + '">😼 Средне</button>' +
            '<button class="game-control-btn" onclick="game.chessSetDifficulty(\"hard\")" style="' + (this.chessDifficulty==='hard'?'background:#e74c3c;':'') + '">😈 Сложно</button>' +
            '<button class="game-control-btn" onclick="game.initChess()">🔄 Новая</button>' +
            '</div>';
        document.onkeydown = null;
    },
    
    chessSetDifficulty(d) {
        this.chessDifficulty = d;
        this.chessAIDepth = d === 'easy' ? 1 : d === 'medium' ? 2 : 3;
        this.initChess();
    },
    
    isWhitePiece(piece) {
        return '♔♕♖♗♘♙'.includes(piece);
    },
    
    isBlackPiece(piece) {
        return '♚♜♝♞♟'.includes(piece);
    },
    
    handleChessClick(row, col, ctx) {
        if (this.chessTurn !== 'white') return;
        
        if (this.chessSelected) {
            const move = this.chessPossibleMoves.find(m => m.row === row && m.col === col);
            if (move) {
                const piece = this.chessBoard[this.chessSelected.row][this.chessSelected.col];
                this.chessBoard[row][col] = piece;
                this.chessBoard[this.chessSelected.row][this.chessSelected.col] = '';
                
                // Превращение пешки
                if (piece === '♙' && row === 0) this.chessBoard[row][col] = '♕';
                
                this.chessSelected = null;
                this.chessPossibleMoves = [];
                this.chessTurn = 'black';
                this.updateScore(5);
                this.drawChess(ctx);
                
                // AI делает ход
                setTimeout(() => this.chessAIMove(ctx), 400);
                return;
            }
        }
        
        const piece = this.chessBoard[row][col];
        if (piece && this.isWhitePiece(piece)) {
            this.chessSelected = { row, col };
            this.chessPossibleMoves = this.getChessMoves(row, col, piece);
        } else {
            this.chessSelected = null;
            this.chessPossibleMoves = [];
        }
        this.drawChess(ctx);
    },
    
    // ===== AI ШАХМАТ =====
    chessEvaluate() {
        const values = { '♙': 1, '♘': 3, '♗': 3, '♖': 5, '♕': 9, '♔': 0, '♟': 1, '♞': 3, '♝': 3, '♜': 5, '♛': 9, '♚': 0 };
        let score = 0;
        const centerBonus = [[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,1,1,1,1,0,0],[0,0,1,2,2,1,0,0],[0,0,1,2,2,1,0,0],[0,0,1,1,1,1,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0]];
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const p = this.chessBoard[r][c];
                if (p) {
                    const v = (values[p] || 0) + (centerBonus[r][c] || 0) * 0.3;
                    score += this.isBlackPiece(p) ? v : -v;
                }
            }
        }
        return score;
    },
    
    chessMinimax(depth, isMax, alpha, beta) {
        if (depth === 0) return this.chessEvaluate();
        
        const color = isMax ? 'black' : 'white';
        let bestVal = isMax ? -Infinity : Infinity;
        
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const p = this.chessBoard[r][c];
                if (!p) continue;
                if ((isMax && !this.isBlackPiece(p)) || (!isMax && !this.isWhitePiece(p))) continue;
                
                const moves = this.getChessMoves(r, c, p);
                for (const m of moves) {
                    const captured = this.chessBoard[m.row][m.col];
                    this.chessBoard[m.row][m.col] = p;
                    this.chessBoard[r][c] = '';
                    
                    const val = this.chessMinimax(depth - 1, !isMax, alpha, beta);
                    
                    this.chessBoard[r][c] = p;
                    this.chessBoard[m.row][m.col] = captured;
                    
                    if (isMax) { bestVal = Math.max(bestVal, val); alpha = Math.max(alpha, val); }
                    else { bestVal = Math.min(bestVal, val); beta = Math.min(beta, val); }
                    if (beta <= alpha) return bestVal;
                }
            }
        }
        return bestVal;
    },
    
    chessAIMove(ctx) {
        if (this.chessTurn !== 'black') return;
        
        let bestMove = null;
        let bestVal = -Infinity;
        const candidates = [];
        
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const p = this.chessBoard[r][c];
                if (!p || !this.isBlackPiece(p)) continue;
                const moves = this.getChessMoves(r, c, p);
                for (const m of moves) {
                    const captured = this.chessBoard[m.row][m.col];
                    this.chessBoard[m.row][m.col] = p;
                    this.chessBoard[r][c] = '';
                    
                    const val = this.chessMinimax(this.chessAIDepth, false, -Infinity, Infinity);
                    
                    this.chessBoard[r][c] = p;
                    this.chessBoard[m.row][m.col] = captured;
                    
                    if (this.chessDifficulty === 'easy') {
                        candidates.push({ fromR: r, fromC: c, toR: m.row, toC: m.col, val: val + Math.random() * 0.5 });
                    } else {
                        if (val > bestVal) { bestVal = val; bestMove = { fromR: r, fromC: c, toR: m.row, toC: m.col }; }
                    }
                }
            }
        }
        
        if (this.chessDifficulty === 'easy' && candidates.length > 0) {
            candidates.sort((a, b) => b.val - a.val);
            bestMove = candidates[0];
        }
        
        if (!bestMove) {
            this.chessTurn = 'white';
            return;
        }
        
        const piece = this.chessBoard[bestMove.fromR][bestMove.fromC];
        this.chessBoard[bestMove.toR][bestMove.toC] = piece;
        this.chessBoard[bestMove.fromR][bestMove.fromC] = '';
        
        // Превращение пешки
        if (piece === '♟' && bestMove.toR === 7) this.chessBoard[bestMove.toR][bestMove.toC] = '♛';
        
        this.chessTurn = 'white';
        this.updateScore(5);
        this.drawChess(ctx);
    },
    
    drawChess(ctx) {
        const size = 60;
        // Доска
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const x = col * size;
                const y = row * size;
                
                // Цвет клетки
                if (this.chessSelected && this.chessSelected.row === row && this.chessSelected.col === col) {
                    ctx.fillStyle = '#8297d9';
                } else if (this.chessPossibleMoves.some(m => m.row === row && m.col === col)) {
                    const piece = this.chessBoard[row][col];
                    ctx.fillStyle = piece ? 'rgba(231,76,60,0.5)' : 'rgba(130,200,100,0.6)';
                } else {
                    ctx.fillStyle = (row + col) % 2 === 0 ? '#f0d9b5' : '#b58863';
                }
                ctx.fillRect(x, y, size, size);
                
                // Рисуем фигуру
                const piece = this.chessBoard[row][col];
                if (piece) {
                    const isW = this.isWhitePiece(piece);
                    this.drawCatPiece(ctx, x + size/2, y + size/2, size * 0.42, piece, isW);
                }
            }
        }
        
        // Статус
        ctx.fillStyle = 'white';
        ctx.font = 'bold 13px Arial';
        ctx.textAlign = 'left';
        const turn = this.chessTurn === 'white' ? 'Ваш ход ⬜' : 'Думает AI... ⬛';
        ctx.fillText(turn, 5, 475);
    },
    
    // ===== РИСОВАНИЕ КОШАЧЬИХ ФИГУР =====
    drawCatPiece(ctx, cx, cy, size, piece, isWhite) {
        const c = isWhite ? this.chessColors.white : this.chessColors.black;
        const s = size;
        ctx.save();
        
        // Определяем тип фигуры
        const type = this.chessPieceType(piece);
        
        // Базовая платформа
        ctx.fillStyle = c.dark;
        ctx.beginPath();
        ctx.ellipse(cx, cy + s*0.45, s*0.5, s*0.12, 0, 0, Math.PI*2);
        ctx.fill();
        
        if (type === 'pawn') {
            // Пешка — маленький кот
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.arc(cx, cy - s*0.05, s*0.3, 0, Math.PI*2);
            ctx.fill();
            // Мордочка
            ctx.fillStyle = c.light;
            ctx.beginPath();
            ctx.arc(cx, cy + s*0.0, s*0.2, 0, Math.PI*2);
            ctx.fill();
            // Уши
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.moveTo(cx - s*0.22, cy - s*0.22);
            ctx.lineTo(cx - s*0.12, cy - s*0.42);
            ctx.lineTo(cx - s*0.02, cy - s*0.18);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(cx + s*0.22, cy - s*0.22);
            ctx.lineTo(cx + s*0.12, cy - s*0.42);
            ctx.lineTo(cx + s*0.02, cy - s*0.18);
            ctx.closePath();
            ctx.fill();
            // Глазки
            ctx.fillStyle = c.eyes;
            ctx.beginPath(); ctx.arc(cx - s*0.1, cy - s*0.05, s*0.05, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(cx + s*0.1, cy - s*0.05, s*0.05, 0, Math.PI*2); ctx.fill();
            // Нос
            ctx.fillStyle = isWhite ? '#dda0dd' : '#8a6a8a';
            ctx.beginPath(); ctx.arc(cx, cy + s*0.05, s*0.03, 0, Math.PI*2); ctx.fill();
            // Сердечко
            ctx.fillStyle = isWhite ? '#e8b0e8' : '#6a4a6a';
            ctx.font = `${s*0.2}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('♥', cx, cy + s*0.25);
            
        } else if (type === 'rook') {
            // Ладья — башня с кошачьими ушами
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.roundRect(cx - s*0.25, cy - s*0.35, s*0.5, s*0.65, [s*0.08, s*0.08, 0, 0]);
            ctx.fill();
            // Зубцы
            ctx.fillStyle = c.dark;
            for (let i = -1; i <= 1; i++) {
                ctx.fillRect(cx + i*s*0.16 - s*0.06, cy - s*0.48, s*0.12, s*0.15);
            }
            // Уши на зубцах
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.moveTo(cx - s*0.2, cy - s*0.42);
            ctx.lineTo(cx - s*0.12, cy - s*0.55);
            ctx.lineTo(cx - s*0.04, cy - s*0.42);
            ctx.closePath(); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(cx + s*0.04, cy - s*0.42);
            ctx.lineTo(cx + s*0.12, cy - s*0.55);
            ctx.lineTo(cx + s*0.2, cy - s*0.42);
            ctx.closePath(); ctx.fill();
            // Окно
            ctx.fillStyle = c.light;
            ctx.beginPath();
            ctx.arc(cx, cy - s*0.1, s*0.1, 0, Math.PI*2);
            ctx.fill();
            // Лапка
            ctx.fillStyle = isWhite ? '#e8d0f8' : '#4a3a5a';
            ctx.font = `${s*0.18}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🐾', cx, cy + s*0.18);
            
        } else if (type === 'knight') {
            // Конь — кошачья голова с гривой
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.ellipse(cx, cy - s*0.05, s*0.28, s*0.35, 0, 0, Math.PI*2);
            ctx.fill();
            // Грива
            ctx.fillStyle = c.dark;
            ctx.beginPath();
            ctx.ellipse(cx - s*0.22, cy - s*0.15, s*0.12, s*0.25, -0.3, 0, Math.PI*2);
            ctx.fill();
            // Уши
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.moveTo(cx - s*0.15, cy - s*0.32);
            ctx.lineTo(cx - s*0.08, cy - s*0.52);
            ctx.lineTo(cx + s*0.0, cy - s*0.3);
            ctx.closePath(); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(cx + s*0.1, cy - s*0.35);
            ctx.lineTo(cx + s*0.2, cy - s*0.5);
            ctx.lineTo(cx + s*0.25, cy - s*0.3);
            ctx.closePath(); ctx.fill();
            // Мордочка
            ctx.fillStyle = c.light;
            ctx.beginPath();
            ctx.ellipse(cx + s*0.05, cy, s*0.18, s*0.2, 0.1, 0, Math.PI*2);
            ctx.fill();
            // Глаз
            ctx.fillStyle = c.eyes;
            ctx.beginPath(); ctx.arc(cx + s*0.0, cy - s*0.1, s*0.06, 0, Math.PI*2); ctx.fill();
            // Нос
            ctx.fillStyle = isWhite ? '#dda0dd' : '#8a6a8a';
            ctx.beginPath(); ctx.arc(cx + s*0.1, cy + s*0.0, s*0.035, 0, Math.PI*2); ctx.fill();
            
        } else if (type === 'bishop') {
            // Слон — высокий кот с митрой
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.roundRect(cx - s*0.2, cy - s*0.2, s*0.4, s*0.5, s*0.1);
            ctx.fill();
            // Митра
            ctx.fillStyle = c.dark;
            ctx.beginPath();
            ctx.moveTo(cx, cy - s*0.5);
            ctx.lineTo(cx - s*0.18, cy - s*0.25);
            ctx.lineTo(cx + s*0.18, cy - s*0.25);
            ctx.closePath(); ctx.fill();
            // Крест на митре
            ctx.strokeStyle = isWhite ? '#fff' : '#ccc';
            ctx.lineWidth = s*0.04;
            ctx.beginPath();
            ctx.moveTo(cx, cy - s*0.55);
            ctx.lineTo(cx, cy - s*0.42);
            ctx.moveTo(cx - s*0.06, cy - s*0.48);
            ctx.lineTo(cx + s*0.06, cy - s*0.48);
            ctx.stroke();
            // Уши под митрой
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.moveTo(cx - s*0.2, cy - s*0.22);
            ctx.lineTo(cx - s*0.1, cy - s*0.38);
            ctx.lineTo(cx, cy - s*0.22);
            ctx.closePath(); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(cx, cy - s*0.22);
            ctx.lineTo(cx + s*0.1, cy - s*0.38);
            ctx.lineTo(cx + s*0.2, cy - s*0.22);
            ctx.closePath(); ctx.fill();
            // Глазки
            ctx.fillStyle = c.eyes;
            ctx.beginPath(); ctx.arc(cx - s*0.07, cy - s*0.08, s*0.05, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(cx + s*0.07, cy - s*0.08, s*0.05, 0, Math.PI*2); ctx.fill();
            // Лапка
            ctx.fillStyle = isWhite ? '#e8d0f8' : '#4a3a5a';
            ctx.font = `${s*0.16}px Arial`;
            ctx.textAlign = 'center';
            ctx.fillText('🐾', cx, cy + s*0.15);
            
        } else if (type === 'queen') {
            // Ферзь — королева с короной
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.ellipse(cx, cy + s*0.05, s*0.25, s*0.3, 0, 0, Math.PI*2);
            ctx.fill();
            // Корона
            ctx.fillStyle = isWhite ? '#ffd700' : '#daa520';
            ctx.beginPath();
            ctx.moveTo(cx - s*0.22, cy - s*0.2);
            ctx.lineTo(cx - s*0.18, cy - s*0.38);
            ctx.lineTo(cx - s*0.08, cy - s*0.25);
            ctx.lineTo(cx, cy - s*0.42);
            ctx.lineTo(cx + s*0.08, cy - s*0.25);
            ctx.lineTo(cx + s*0.18, cy - s*0.38);
            ctx.lineTo(cx + s*0.22, cy - s*0.2);
            ctx.closePath(); ctx.fill();
            // Уши
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.moveTo(cx - s*0.18, cy - s*0.2);
            ctx.lineTo(cx - s*0.1, cy - s*0.35);
            ctx.lineTo(cx - s*0.02, cy - s*0.18);
            ctx.closePath(); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(cx + s*0.02, cy - s*0.18);
            ctx.lineTo(cx + s*0.1, cy - s*0.35);
            ctx.lineTo(cx + s*0.18, cy - s*0.2);
            ctx.closePath(); ctx.fill();
            // Мордочка
            ctx.fillStyle = c.light;
            ctx.beginPath();
            ctx.arc(cx, cy + s*0.05, s*0.18, 0, Math.PI*2);
            ctx.fill();
            // Глаза
            ctx.fillStyle = c.eyes;
            ctx.beginPath(); ctx.arc(cx - s*0.08, cy - s*0.0, s*0.05, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(cx + s*0.08, cy - s*0.0, s*0.05, 0, Math.PI*2); ctx.fill();
            // Нос
            ctx.fillStyle = isWhite ? '#dda0dd' : '#8a6a8a';
            ctx.beginPath(); ctx.arc(cx, cy + s*0.1, s*0.03, 0, Math.PI*2); ctx.fill();
            // Колокольчик
            ctx.fillStyle = isWhite ? '#ffd700' : '#b8860b';
            ctx.beginPath(); ctx.arc(cx, cy + s*0.25, s*0.06, 0, Math.PI*2); ctx.fill();
            
        } else if (type === 'king') {
            // Король — кот с крестом
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.ellipse(cx, cy + s*0.05, s*0.25, s*0.3, 0, 0, Math.PI*2);
            ctx.fill();
            // Крест
            ctx.strokeStyle = isWhite ? '#ffd700' : '#daa520';
            ctx.lineWidth = s*0.07;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(cx, cy - s*0.3);
            ctx.lineTo(cx, cy - s*0.5);
            ctx.moveTo(cx - s*0.08, cy - s*0.4);
            ctx.lineTo(cx + s*0.08, cy - s*0.4);
            ctx.stroke();
            // Уши
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.moveTo(cx - s*0.18, cy - s*0.2);
            ctx.lineTo(cx - s*0.1, cy - s*0.38);
            ctx.lineTo(cx - s*0.02, cy - s*0.18);
            ctx.closePath(); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(cx + s*0.02, cy - s*0.18);
            ctx.lineTo(cx + s*0.1, cy - s*0.38);
            ctx.lineTo(cx + s*0.18, cy - s*0.2);
            ctx.closePath(); ctx.fill();
            // Мордочка
            ctx.fillStyle = c.light;
            ctx.beginPath();
            ctx.arc(cx, cy + s*0.05, s*0.18, 0, Math.PI*2);
            ctx.fill();
            // Глаза
            ctx.fillStyle = c.eyes;
            ctx.beginPath(); ctx.arc(cx - s*0.08, cy - s*0.0, s*0.05, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(cx + s*0.08, cy - s*0.0, s*0.05, 0, Math.PI*2); ctx.fill();
            // Нос
            ctx.fillStyle = isWhite ? '#dda0dd' : '#8a6a8a';
            ctx.beginPath(); ctx.arc(cx, cy + s*0.1, s*0.03, 0, Math.PI*2); ctx.fill();
            // Колокольчик
            ctx.fillStyle = isWhite ? '#ffd700' : '#b8860b';
            ctx.beginPath(); ctx.arc(cx, cy + s*0.25, s*0.06, 0, Math.PI*2); ctx.fill();
        }
        
        ctx.restore();
    },
    
    chessPieceType(piece) {
        if ('♟♙'.includes(piece)) return 'pawn';
        if ('♜♖'.includes(piece)) return 'rook';
        if ('♞♘'.includes(piece)) return 'knight';
        if ('♝♗'.includes(piece)) return 'bishop';
        if ('♛♕'.includes(piece)) return 'queen';
        if ('♚♔'.includes(piece)) return 'king';
        return 'pawn';
    },
    
    getChessMoves(row, col, piece) {
        const moves = [];
        const board = this.chessBoard;
        const isWhite = this.isWhitePiece(piece);
        const isBlack = this.isBlackPiece(piece);
        
        const addIfValid = (r, c) => {
            if (r < 0 || r > 7 || c < 0 || c > 7) return false;
            const target = board[r][c];
            if (target && (isWhite ? this.isWhitePiece(target) : this.isBlackPiece(target))) return false;
            moves.push({ row: r, col: c });
            return !target;
        };
        
        const addSliding = (dr, dc) => {
            for (let i = 1; i < 8; i++) {
                if (!addIfValid(row + dr*i, col + dc*i)) break;
            }
        };
        
        const type = piece.toLowerCase();
        const dir = isWhite ? -1 : 1;
        
        if (type === '♟' || type === '♙') {
            if (!board[row + dir]?.[col]) {
                moves.push({ row: row + dir, col });
                if ((isWhite && row === 6) || (isBlack && row === 1)) {
                    if (!board[row + dir*2]?.[col]) moves.push({ row: row + dir*2, col });
                }
            }
            for (const dc of [-1, 1]) {
                const tr = row + dir, tc = col + dc;
                if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8 && board[tr][tc]) {
                    const t = board[tr][tc];
                    if (isWhite && this.isBlackPiece(t)) moves.push({ row: tr, col: tc });
                    if (isBlack && this.isWhitePiece(t)) moves.push({ row: tr, col: tc });
                }
            }
        } else if (type === '♜') {
            addSliding(1, 0); addSliding(-1, 0); addSliding(0, 1); addSliding(0, -1);
        } else if (type === '♞') {
            const jumps = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
            jumps.forEach(([dr,dc]) => addIfValid(row+dr, col+dc));
        } else if (type === '♝') {
            addSliding(1,1); addSliding(1,-1); addSliding(-1,1); addSliding(-1,-1);
        } else if (type === '♛') {
            addSliding(1,0); addSliding(-1,0); addSliding(0,1); addSliding(0,-1);
            addSliding(1,1); addSliding(1,-1); addSliding(-1,1); addSliding(-1,-1);
        } else if (type === '♚') {
            [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => addIfValid(row+dr, col+dc));
        }
        
        return moves;
    },
    
    // ===== ШАХМАТЫ КОНЕЦ =====
        // NONSTOP BALLS — legacy removed (see HELLFIRE BALLS class; launched via game.startMinigame('hellfire'))
    // Переключение экрана
    switchScreen(screenId) {
        // Pet animation rAF loop only runs while mainScreen is active
        if (screenId === 'mainScreen') this.startPetAnimLoop();
        else this.stopPetAnimLoop();

        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(screenId).classList.add('active');
    },

    // Сохранить рисунок из редактора
    async saveSketch() {
        const imageData = this.editor.getImageData();
        const title = prompt('Назовите ваш рисунок:', 'Рисунок ' + new Date().toLocaleString());
        if (!title) return;
        try {
            const response = await fetch(API_BASE + '/sketches/' + this.petId + '/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, imageData })
            });
            if (!response.ok) throw new Error('Save failed');
            const savedJson = await response.json().catch(function () { return {}; });
            const backendSketch = savedJson && (savedJson.sketch || savedJson);
            // Persistence fix: append the just-saved sketch to the local
            // cache so when backToSketchList() reloads the notebook it is
            // visible without depending on a backend round-trip shape.
            if (backendSketch && (backendSketch.id || backendSketch.imageData || backendSketch.image_data)) {
                if (!Array.isArray(this.sketchPages)) this.sketchPages = [];
                this.sketchPages = Array.isArray(this.sketchPages) ? this.sketchPages : [];
                this.sketchPages.unshift({
                    id: backendSketch.id || ('local-' + Date.now()),
                    title: backendSketch.title || title,
                    imageData: backendSketch.imageData || backendSketch.image_data || imageData,
                    created_at: backendSketch.created_at || backendSketch.createdAt || new Date().toISOString()
                });
                this.currentPageIndex = 0;
            }
            this.addNotification('Рисунок сохранён! 😻', 'success');
            await this.getPetStatus();
            this.updateUI();
            this.backToSketchList();
        } catch (error) {
            console.error('Error saving sketch:', error);
            this.addNotification('Не удалось сохранить рисунок.', 'error');
        }
    },

    // Скачать из редактора как PNG
    exportSketch() {
        const filename = 'sketch-' + Date.now() + '.png';
        this.editor.canvas.toBlob((blob) => {
            if (!blob) return;
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = filename;
            link.click();
            this.addNotification('Скачано: ' + filename, 'success');
        }, 'image/png');
    },

    // ===== АНТИСТРЕСС: пузырчатая плёнка =====
    antiStressTotalBubbles: 18,
    antiStressPopped: 0,
    antiStressInitialized: false,

    // Открыть оверлей антистресса
    openAntiStress() {
        if (!this.antiStressInitialized) {
            this.buildAntiStressSheet();
            this.antiStressInitialized = true;
        }
        document.getElementById('antiStressOverlay').classList.add('open');
    },

    // Закрыть оверлей антистресса
    closeAntiStress() {
        document.getElementById('antiStressOverlay').classList.remove('open');
    },

    // Построить сетку пузырьков (6 × 3)
    buildAntiStressSheet() {
        const sheet = document.getElementById('antiStressSheet');
        sheet.innerHTML = '';
        for (let i = 0; i < this.antiStressTotalBubbles; i++) {
            const bubble = document.createElement('div');
            bubble.className = 'anti-stress-bubble';
            bubble.dataset.idx = i;
            bubble.addEventListener('click', () => this.popAntiStressBubble(bubble));
            sheet.appendChild(bubble);
        }
        // Счётчик лопнувших пузырьков (вставляем над листом)
        const wrap = document.querySelector('.anti-stress-wrap');
        if (wrap && !document.getElementById('antiStressCounter')) {
            const counter = document.createElement('div');
            counter.className = 'anti-stress-counter';
            counter.id = 'antiStressCounter';
            wrap.insertBefore(counter, sheet);
        }
        sheet.classList.remove('glow');
        this.antiStressPopped = 0;
        this.updateAntiStressCounter();
    },

    // Обновить счётчик лопнутых
    updateAntiStressCounter() {
        const c = document.getElementById('antiStressCounter');
        if (c) c.textContent = this.antiStressPopped + ' / ' + this.antiStressTotalBubbles + ' 💥';
    },

    // Лопнуть один пузырёк (каждый со своим хитбоксом)
    popAntiStressBubble(bubble) {
        if (bubble.classList.contains('popped')) return;
        const idx = parseInt(bubble.dataset.idx, 10) || 0;

        // Частица-«пуф» внутри лопнувшего пузырька
        this.spawnPuffParticle(bubble);

        bubble.classList.add('popping');
        setTimeout(() => {
            bubble.classList.remove('popping');
            bubble.classList.add('popped');
        }, 180);

        this.antiStressPopped++;
        this.playBubblePop(idx);
        this.updateAntiStressCounter();

        // Если все лопнули — подсвечиваем лист и проигрываем динг
        if (this.antiStressPopped === this.antiStressTotalBubbles) {
            const sheet = document.getElementById('antiStressSheet');
            if (sheet) sheet.classList.add('glow');
            setTimeout(() => this.playCompletionDing(), 220);
        }
    },

    // Создать частицу-«пуф» внутри лопнувшего пузырька
    spawnPuffParticle(bubble) {
        const puff = document.createElement('div');
        puff.className = 'anti-stress-puff';
        bubble.appendChild(puff);
        setTimeout(() => puff.remove(), 520);
    },

    // Заменить лист на новый (сбросить все пузырьки)
    resetAntiStress() {
        const sheet = document.getElementById('antiStressSheet');
        sheet.querySelectorAll('.anti-stress-bubble').forEach(b => {
            b.classList.remove('popped', 'popping');
            b.querySelectorAll('.anti-stress-puff').forEach(p => p.remove());
        });
        sheet.classList.remove('glow');
        this.antiStressPopped = 0;
        this.playResetWhoosh();
        this.updateAntiStressCounter();
        this.addNotification('Новый лист антистресса готов 💆', 'info');
    },

    // Web Audio: приятный «поп» с вариацией высоты по индексу пузырька
    playBubblePop(idx = 0) {
        if (!this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        const now = this.audioCtx.currentTime;

        // Питч-вариация: колонка (idx % 6) + детерминированный jitter → каждый поп звучит чуть иначе
        const col = idx % 6;
        const jitter = ((idx * 7919) % 11) / 100;       // 0..0.10
        const bodyStart = 880 + col * 55 + jitter * 80; // 880..1335 Hz
        const bodyEnd = 200 + col * 12;                  // 200..272 Hz
        const subStart = 110 + col * 8;                  // 110..158 Hz

        // 1) САБ-удар — низкий толчок, даёт «поп»-панч
        const sub = this.audioCtx.createOscillator();
        const subGain = this.audioCtx.createGain();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(subStart, now);
        sub.frequency.exponentialRampToValueAtTime(60, now + 0.08);
        subGain.gain.setValueAtTime(0.18, now);
        subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.10);
        sub.connect(subGain).connect(this.audioCtx.destination);
        sub.start(now); sub.stop(now + 0.10);

        // 2) ОСНОВНОЙ тел-тон — быстрый pitch-fall (характерный «поп»)
        const body = this.audioCtx.createOscillator();
        const bodyGain = this.audioCtx.createGain();
        body.type = 'sine';
        body.frequency.setValueAtTime(bodyStart, now);
        body.frequency.exponentialRampToValueAtTime(bodyEnd, now + 0.09);
        bodyGain.gain.setValueAtTime(0.16, now);
        bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
        body.connect(bodyGain).connect(this.audioCtx.destination);
        body.start(now); body.stop(now + 0.13);

        // 3) МЕТАЛЛИЧЕСКАЯ гармоника — sparkle
        const harm = this.audioCtx.createOscillator();
        const harmGain = this.audioCtx.createGain();
        harm.type = 'triangle';
        harm.frequency.setValueAtTime(bodyStart * 2.1, now + 0.005);
        harm.frequency.exponentialRampToValueAtTime(bodyEnd * 1.5, now + 0.07);
        harmGain.gain.setValueAtTime(0.05, now + 0.005);
        harmGain.gain.exponentialRampToValueAtTime(0.001, now + 0.10);
        harm.connect(harmGain).connect(this.audioCtx.destination);
        harm.start(now + 0.005); harm.stop(now + 0.10);

        // 4) АТАКА-щелчок — короткий tick на самом верху для воздушности
        const tick = this.audioCtx.createOscillator();
        const tickGain = this.audioCtx.createGain();
        tick.type = 'square';
        tick.frequency.setValueAtTime(3000, now);
        tickGain.gain.setValueAtTime(0.025, now);
        tickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
        tick.connect(tickGain).connect(this.audioCtx.destination);
        tick.start(now); tick.stop(now + 0.025);
    },

    // Web Audio: «ктоosh» при сбросе листа — пара свистов через lowpass (как смахивание)
    playResetWhoosh() {
        if (!this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        const now = this.audioCtx.currentTime;

        const makeSwipe = (startFreq, endFreq, delay) => {
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            const filter = this.audioCtx.createBiquadFilter();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(startFreq, now + delay);
            osc.frequency.exponentialRampToValueAtTime(endFreq, now + delay + 0.18);
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(1200, now + delay);
            filter.Q.value = 4;
            gain.gain.setValueAtTime(0.0, now + delay);
            gain.gain.linearRampToValueAtTime(0.10, now + delay + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.22);
            osc.connect(filter).connect(gain).connect(this.audioCtx.destination);
            osc.start(now + delay); osc.stop(now + delay + 0.22);
        };
        // Восходящий свист + парный нисходящий = жест «смахивания»
        makeSwipe(220, 880, 0);
        makeSwipe(880, 220, 0.10);
    },

    // Web Audio: финальный динг когда все пузырьки лопнули — арпеджио C5→E5→G5 + C6 shimmer
    playCompletionDing() {
        if (!this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        const now = this.audioCtx.currentTime;

        // C5 = 523.25, E5 = 659.25, G5 = 783.99
        [523.25, 659.25, 783.99].forEach((freq, i) => {
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now + i * 0.10);
            gain.gain.setValueAtTime(0.0, now + i * 0.10);
            gain.gain.linearRampToValueAtTime(0.16, now + i * 0.10 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.10 + 0.55);
            osc.connect(gain).connect(this.audioCtx.destination);
            osc.start(now + i * 0.10); osc.stop(now + i * 0.10 + 0.55);
        });

        // Тёплый хвост на C6 для shimmer
        const tail = this.audioCtx.createOscillator();
        const tailGain = this.audioCtx.createGain();
        tail.type = 'triangle';
        tail.frequency.setValueAtTime(1046.5, now + 0.20);
        tailGain.gain.setValueAtTime(0.06, now + 0.20);
        tailGain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
        tail.connect(tailGain).connect(this.audioCtx.destination);
        tail.start(now + 0.20); tail.stop(now + 0.85);
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
        // Hitbox fix: sync canvas.width/height to its CSS-rendered rect
        // so mouse coords from getBoundingClientRect() map exactly to
        // canvas pixels (the old code used the HTML attribute size,
        // which mismatches whenever the canvas is CSS-scaled).
        this.fitCanvasToDisplay();
    }

    // Reflect the canvas's CSS-rendered rect into the backing-store
    // dimensions; re-fit on resize via a ResizeObserver on the parent.
    fitCanvasToDisplay() {
        const rect = this.canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return; // not laid out yet
        // Preserve any current drawing before resize
        let prevData = null;
        try {
            if (this.canvas.width > 0 && this.canvas.height > 0) {
                prevData = this.canvas.toDataURL();
            }
        } catch (e) { /* tainted canvas — ignore */ }
        // Cap to keep dataURLs reasonable even on 4K screens
        const capW = 1200, capH = 800;
        const w = Math.min(Math.max(2, Math.round(rect.width)), capW);
        const h = Math.min(Math.max(2, Math.round(rect.height)), capH);
        this.canvas.width = w;
        this.canvas.height = h;
        if (prevData) this._restoreSketchData(prevData);
        else {
            this.ctx.fillStyle = 'white';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.saveHistory();
        }
        // Auto-refit when the wrapper resizes (window resize, rotation,
        // screen change, or modal swap that re-mounts the canvas).
        if (!this._resizeObserver && typeof ResizeObserver !== 'undefined') {
            const target = this.canvas.parentElement || this.canvas;
            this._resizeObserver = new ResizeObserver(() => this.fitCanvasToDisplay());
            this._resizeObserver.observe(target);
        }
    }

    // Re-paint a saved dataURI onto the canvas after a resize.
    _restoreSketchData(dataURL) {
        const img = new Image();
        img.onload = () => {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(img, 0, 0);
            this.saveHistory();
        };
        img.onerror = () => {
            // prev dataURI unusable — leave the freshly sized white canvas
            this.ctx.fillStyle = 'white';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.saveHistory();
        };
        img.src = dataURL;
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
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = ((e.clientX || e.touches[0].clientX) - rect.left) * scaleX;
        const y = ((e.clientY || e.touches[0].clientY) - rect.top) * scaleY;
        
        this.ctx.beginPath();
        this.ctx.moveTo(x, y);
    }

    draw(e) {
        if (!this.isDrawing) return;
        
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = ((e.clientX || e.touches[0].clientX) - rect.left) * scaleX;
        const y = ((e.clientY || e.touches[0].clientY) - rect.top) * scaleY;
        
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


// ============================================================================
// HELLFIRE BALLS — endless hell-themed brick-breaker (replaces old 'nonstop')
// ============================================================================
class HellfireBallsGame {
    constructor(parent) {
        this.parent = parent;
        this.screen = null;
        this.canvas = null;
        this.ctx = null;
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.W = 0; this.H = 0;
        this.cannonX = 0; this.cannonY = 0;
        this.cannonAngle = -Math.PI / 2;     // default = pointing up
        this.cols = 6;
        this.rows = 14;                       // max visible rows
        this.cellW = 0; this.cellH = 0;
        this.cellTopOffset = 40;
        this.defeatLineY = 0;
        this.blocks = [];
        this.balls = [];
        this.particles = [];
        this.ballCount = 1;                   // salvo size
        this.ballsInReserve = 1;              // carry over after pickups
        this.armedBomb = false;
        this.bombAvailableForTurn = false;
        this.state = 'AIMING';                // AIMING | SHOOTING | GAME_OVER
        this.score = 0;
        this.turn = 0;
        this.destroyedThisTurn = 0;
        this.highScore = this._readHighScore();
        this.running = false;
        this._lastT = 0;
        this._onResize = null;
        this._handlers = [];
        this.shakeT = 0;
        this.shakeAmp = 0;
    }

    _readHighScore() {
        try { return parseInt(localStorage.getItem('hellfire_high') || '0', 10) || 0; } catch (e) { return 0; }
    }
    _writeHighScore(v) {
        try { localStorage.setItem('hellfire_high', String(v)); } catch (e) {}
    }

    start() {
        this.screen = document.getElementById('hellfireScreen');
        this.canvas = document.getElementById('hellfireCanvas');
        if (!this.screen || !this.canvas) {
            console.warn('HellfireBallsGame: missing screen/canvas elements');
            return;
        }
        this.ctx = this.canvas.getContext('2d');
        this.parent.currentGame = 'hellfire';
        this.screen.style.display = 'flex';
        // Hide the shared mini-game screen if it's open underneath
        const gs = document.getElementById('gameScreen');
        if (gs) gs.style.display = 'none';

        this.fitCanvas();
        this.reset();
        this.bindEvents();
        this.running = true;
        this._lastT = performance.now();
        requestAnimationFrame((t) => this.loop(t));
    }

    stop() {
        this.running = false;
        if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; }
        for (const h of this._handlers) { try { h.el.removeEventListener(h.ev, h.fn); } catch (e) {} }
        this._handlers = [];
        if (this.screen) this.screen.style.display = 'none';
        const go = document.getElementById('hellfireGameover'); if (go) go.classList.remove('show');
    }

    fitCanvas() {
        const rect = this.screen.getBoundingClientRect();
        const maxW = rect.width - 24;
        const maxH = rect.height - 84;        // leave room for controls bar
        const ar = 900 / 620;
        let lw = maxW, lh = maxH;
        if (lw / lh > ar) lw = lh * ar; else lh = lw / ar;
        this.W = Math.round(lw);
        this.H = Math.round(lh);
        this.canvas.style.width = this.W + 'px';
        this.canvas.style.height = this.H + 'px';
        this.canvas.width  = this.W * this.dpr;
        this.canvas.height = this.H * this.dpr;
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.cellW = this.W / this.cols;
        this.cellH = (this.H - this.cellTopOffset - 130) / this.rows;
        this.defeatLineY = this.H - 130;
        this.cannonX = this.W / 2;
        this.cannonY = this.H - 80;
    }

    reset() {
        this.score = 0;
        this.turn = 0;
        this.ballCount = 1;
        this.ballsInReserve = 1;
        this.armedBomb = false;
        this.bombAvailableForTurn = false;
        this.balls = [];
        this.particles = [];
        this.destroyedThisTurn = 0;
        this.state = 'AIMING';
        this.blocks = [];
        this.cannonAngle = -Math.PI / 2;
        this._spawnRowAt(-1, 1);
        const go = document.getElementById('hellfireGameover'); if (go) go.classList.remove('show');
        this.updateHUD();
    }

    // Difficulty curves
    _hpForTurn(t) {
        if (t < 2) return 1;
        if (t < 4) return 2;
        if (t < 7) return 3;
        return Math.min(8, 3 + Math.floor((t - 6) / 3));
    }
    _densityForTurn(t) { return Math.min(0.95, 0.6 + (t - 1) * 0.05); }

    _spawnRowAt(rowIndex, turn) {
        const maxHp = this._hpForTurn(turn);
        const density = this._densityForTurn(turn);
        for (let c = 0; c < this.cols; c++) {
            if (Math.random() > density) continue;
            const r2 = Math.random();
            let type = 'normal';
            if (r2 < 0.06) type = 'bomb';
            else if (r2 < 0.18) type = 'ballBonus';
            this.blocks.push({
                col: c, row: rowIndex, type,
                hp: maxHp, maxHp: maxHp,
                x: (c + 0.5) * this.cellW,
                y: this.cellTopOffset + this.cellH * rowIndex + this.cellH / 2,
                w: this.cellW * 0.9, h: this.cellH * 0.9,
                seed: (c * 13 + rowIndex * 7) | 0
            });
        }
    }

    // === Fire (player clicked/tapped/clicked fire button) ===
    fire() {
        if (this.state !== 'AIMING') return;
        const n = this.ballCount;
        const base = this.cannonAngle;
        const start = (n - 1) / 2;
        for (let i = 0; i < n; i++) {
            const a = base + (i - start) * 0.05;
            this.balls.push({
                x: this.cannonX, y: this.cannonY - 18,
                vx: Math.cos(a) * 360, vy: Math.sin(a) * 360,
                _hitBlockIdx: -1,
                active: true,
                bombArmed: this.armedBomb,
                trail: []
            });
        }
        this.armedBomb = false;
        this.bombAvailableForTurn = false;
        this.state = 'SHOOTING';
        HellfireBallsGame.playFireBallLaunch(this.parent.audioCtx);
        this.updateHUD();
    }

    // === Step ===
    step(dt) {
        // particles always evolve
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += 14 * dt;
            p.life -= dt;
            if (p.life <= 0) this.particles.splice(i, 1);
        }

        if (this.state !== 'SHOOTING') return;

        for (const ball of this.balls) {
            if (!ball.active) continue;
            ball.x += ball.vx * dt;
            ball.y += ball.vy * dt;

            if (ball.x - 6 < 0) { ball.x = 6; ball.vx = Math.abs(ball.vx); this._spark(ball, 3); }
            if (ball.x + 6 > this.W) { ball.x = this.W - 6; ball.vx = -Math.abs(ball.vx); this._spark(ball, 3); }
            if (ball.y - 6 < 0) { ball.y = 6; ball.vy = Math.abs(ball.vy); this._spark(ball, 3); }
            if (ball.y - 6 > this.H) { ball.active = false; continue; }

            // AABB vs each block
            for (let i = 0; i < this.blocks.length; i++) {
                const b = this.blocks[i];
                if (b.hp <= 0) continue;
                const dx = Math.abs(ball.x - b.x);
                const dy = Math.abs(ball.y - b.y);
                if (dx <= b.w / 2 + 6 && dy <= b.h / 2 + 6) {
                    if (ball._hitBlockIdx !== i) {
                        this._handleHit(ball, b, i);
                    }
                    break;     // ball is consumed (or bombs 3x3)
                }
            }
        }

        // Trail decay
        for (const ball of this.balls) {
            for (let i = ball.trail.length - 1; i >= 0; i--) {
                ball.trail[i].life -= dt;
                if (ball.trail[i].life <= 0) ball.trail.splice(i, 1);
            }
            // push current pos into trail
            if (ball.active) ball.trail.push({ x: ball.x, y: ball.y });
            if (ball.trail.length > 22) ball.trail.splice(0, ball.trail.length - 22);
        }

        if (this.balls.every(b => !b.active)) this.endTurn();
    }

    _spark(ball, n) {
        for (let i = 0; i < n; i++) {
            this.particles.push({
                x: ball.x + (Math.random() - 0.5) * 6,
                y: ball.y + (Math.random() - 0.5) * 6,
                vx: (Math.random() - 0.5) * 60,
                vy: (Math.random() - 0.5) * 60 - 20,
                life: 0.32, kind: 'spark'
            });
        }
    }

    _handleHit(ball, block, idx) {
        ball._hitBlockIdx = idx;
        block.hp -= 1;
        this._spawnHitParticles(block.x, block.y, block.hp, block.type);
        HellfireBallsGame.playBlockHit(this.parent.audioCtx);

        let destroyed = false;
        if (block.hp <= 0) {
            destroyed = true;
            this.destroyedThisTurn++;
            // pickups
            if (block.type === 'bomb') this.armedBomb = true;
            if (block.type === 'ballBonus') this.ballsInReserve = Math.min(12, this.ballsInReserve + 1);
            this._spawnDestroyParticles(block.x, block.y, block.type);
            HellfireBallsGame.playBlockDestroy(this.parent.audioCtx, block.type);
            this.blocks.splice(idx, 1);
        }

        // Hell-bomb consume: first ball to hit any block while armed detonates 3x3
        if (ball.bombArmed) {
            ball.bombArmed = false;
            const center = destroyed ? null : block;
            // if the originally-hit block died, use ball pos as center of explosion
            const cx = center ? center.col : Math.max(0, Math.min(this.cols - 1, Math.floor(ball.x / this.cellW)));
            const cy = center ? center.row : Math.floor((ball.y - this.cellTopOffset) / this.cellH);
            HellfireBallsGame.playHellBombDetonate(this.parent.audioCtx);
            this._explode3x3(cx, cy);
            this.shakeFor(0.4, 18);
        }

    }

    _explode3x3(cx, cy) {
        for (let i = this.blocks.length - 1; i >= 0; i--) {
            const b = this.blocks[i];
            if (b.hp <= 0) continue;
            if (Math.abs(b.col - cx) <= 1 && Math.abs(b.row - cy) <= 1) {
                this.destroyedThisTurn++;
                this.score += 10 * Math.max(1, this.turn + 1);
                // treat bomb-bonus pickup here too
                if (b.type === 'bomb') this.armedBomb = true;
                if (b.type === 'ballBonus') this.ballsInReserve = Math.min(12, this.ballsInReserve + 1);
                this._spawnDestroyParticles(b.x, b.y, b.type);
                HellfireBallsGame.playBlockDestroy(this.parent.audioCtx, b.type);
                this.blocks.splice(i, 1);
            }
        }
    }

    _spawnHitParticles(x, y, hpLeft, type) {
        const baseN = 4 + Math.max(0, Math.floor((1 - hpLeft / 5) * 8));
        for (let i = 0; i < baseN; i++) {
            const ang = Math.PI * 2 * Math.random();
            const sp = 60 + Math.random() * 90;
            this.particles.push({
                x, y,
                vx: Math.cos(ang) * sp,
                vy: Math.sin(ang) * sp - 30,
                life: 0.45, kind: type === 'bomb' ? 'bomb' : (type === 'ballBonus' ? 'bonus' : 'hit')
            });
        }
    }

    _spawnDestroyParticles(x, y, type) {
        const n = 26;
        for (let i = 0; i < n; i++) {
            const ang = (Math.PI * 2 / n) * i + (Math.random() - 0.5) * 0.6;
            const sp = 80 + Math.random() * 160;
            this.particles.push({
                x: x + (Math.random() - 0.5) * 8,
                y: y + (Math.random() - 0.5) * 8,
                vx: Math.cos(ang) * sp,
                vy: Math.sin(ang) * sp - 60,
                life: 0.8, kind: type === 'bomb' ? 'bomb' : (type === 'ballBonus' ? 'bonus' : 'destroy')
            });
        }
    }

    endTurn() {
        if (this.state !== 'SHOOTING') return;
        this.state = 'RESOLVING';

        // Combo & per-turn score
        if (this.destroyedThisTurn > 0) {
            const basePerBlock = 10 * Math.max(1, this.turn + 1);
            const baseTotal = basePerBlock * this.destroyedThisTurn;
            const mult = 1 + 0.5 * Math.max(0, this.destroyedThisTurn - 1);
            const gained = Math.round(baseTotal * mult);
            this.score += gained;
            if (this.destroyedThisTurn >= 2) this._showCombo(this.destroyedThisTurn, mult);
        }

        // Shift blocks down by one row, then spawn fresh above
        for (const b of this.blocks) {
            b.row += 1;
            b.y += this.cellH;
        }
        // Game-over check (after shift-down but before new row)
        for (const b of this.blocks) {
            if (b.hp > 0 && b.y + b.h / 2 >= this.defeatLineY) {
                this.state = 'GAME_OVER';
                this._gameOver();
                this.updateHUD();
                return;
            }
        }

        this.turn++;
        this._spawnRowAt(-1, this.turn + 1);

        this.ballCount = Math.min(12, this.ballsInReserve);
        this.destroyedThisTurn = 0;
        this.balls = [];
        this.state = 'AIMING';
        this.updateHUD();
    }

    _showCombo(n, mult) {
        const el = document.getElementById('hellfireCombo');
        if (!el) return;
        el.textContent = 'COMBO ×' + mult.toFixed(1) + '   🔥 ' + n + ' 🎯';
        el.classList.remove('show');
        void el.offsetWidth;
        el.classList.add('show');
    }

    _gameOver() {
        this.running = false;
        const fs = document.getElementById('hellfireFinalScore');
        if (fs) fs.textContent = this.score;
        const bl = document.getElementById('hellfireBestLine');
        if (this.score > this.highScore) {
            this.highScore = this.score;
            this._writeHighScore(this.highScore);
            if (bl) bl.innerHTML = '🏆 Новый рекорд!';
        } else {
            if (bl) bl.innerHTML = 'Лучший результат: <b>' + this.highScore + '</b>';
        }
        const go = document.getElementById('hellfireGameover');
        if (go) go.classList.add('show');
    }

    shakeFor(secs, amp) { this.shakeT = secs; this.shakeAmp = amp; }

    // === Aiming ===
    aimEvent(clientX, clientY) {
        if (this.state !== 'AIMING') return;
        const rect = this.canvas.getBoundingClientRect();
        const x = (clientX - rect.left);
        const y = (clientY - rect.top);
        const dx = x - this.cannonX;
        const dy = y - this.cannonY;
        let ang = Math.atan2(dy, dx);
        // Only allow cannon to face up; if cursor is below cannon, clamp up to near-horizontal
        if (y > this.cannonY + 4) {
            if (Math.abs(dx) < 0.001) { ang = -Math.PI / 2; }
            else {
                const horiz = Math.asin(Math.min(0.9, (this.cannonY + 4 - y) / 200));
                // Pinned just above horizontal: sin(ang) in [-1, -0.05]
                ang = dx > 0 ? -horiz : (-Math.PI + horiz);
            }
        }
        // Final clamp to (PI, 2PI) ∪ (−PI, 0); tighter: −π … 0 (facing up)
        if (ang > -0.05) ang = -0.05;
        if (ang < -Math.PI + 0.05) ang = -Math.PI + 0.05;
        this.cannonAngle = ang;
    }

    // === Events ===
    bindEvents() {
        const onMove = (e) => this.aimEvent(e.clientX, e.clientY);
        const onDown = (e) => { if (e.button !== 0) return; if (this.state === 'AIMING') { this.fire(); e.preventDefault(); } };
        const onTouchStart = (e) => {
            if (!e.touches || e.touches.length === 0) return;
            const t = e.touches[0];
            this.aimEvent(t.clientX, t.clientY);
            if (this.state === 'AIMING') { this.fire(); e.preventDefault(); }
        };
        const onTouchMove = (e) => {
            if (!e.touches || e.touches.length === 0) return;
            const t = e.touches[0];
            this.aimEvent(t.clientX, t.clientY);
            e.preventDefault();
        };
        this._onResize = () => this.fitCanvas();
        window.addEventListener('resize', this._onResize);

        this.canvas.addEventListener('mousemove', onMove);
        this.canvas.addEventListener('mousedown', onDown);
        this.canvas.addEventListener('touchstart', onTouchStart, { passive: false });
        this.canvas.addEventListener('touchmove', onTouchMove, { passive: false });
        this._handlers.push({ el: this.canvas, ev: 'mousemove', fn: onMove });
        this._handlers.push({ el: this.canvas, ev: 'mousedown', fn: onDown });
        this._handlers.push({ el: this.canvas, ev: 'touchstart', fn: onTouchStart });
        this._handlers.push({ el: this.canvas, ev: 'touchmove', fn: onTouchMove });

        const fire = document.getElementById('hellfireFire');
        const close = document.getElementById('hellfireClose');
        const restart = document.getElementById('hellfireRestart');
        if (fire) {
            const fn = () => { if (this.state === 'AIMING') this.fire(); };
            fire.addEventListener('click', fn);
            this._handlers.push({ el: fire, ev: 'click', fn });
        }
        if (close) {
            const fn = () => {
                this.stop();
                if (this.parent.switchScreen) this.parent.switchScreen('minigamesScreen');
            };
            close.addEventListener('click', fn);
            this._handlers.push({ el: close, ev: 'click', fn });
        }
        if (restart) {
            const fn = () => {
                this.reset();
                this.running = true;
                this._lastT = performance.now();
                requestAnimationFrame((t) => this.loop(t));
            };
            restart.addEventListener('click', fn);
            this._handlers.push({ el: restart, ev: 'click', fn });
        }
    }

    updateHUD() {
        const $ = (id) => document.getElementById(id);
        const s = $('hellfireScore'), h = $('hellfireHigh'), w = $('hellfireWave'),
              a = $('hellfireAmmo'), b = $('hellfireBomb');
        if (s) s.textContent = this.score;
        if (h) h.textContent = Math.max(this.highScore, this.score);
        if (w) w.textContent = this.turn + 1;
        if (a) a.textContent = '⚔ ' + this.ballCount;
        if (b) {
            b.textContent = this.armedBomb ? '💣 ГОТОВА' : '💣 —';
            b.classList.toggle('armed', !!this.armedBomb);
        }
    }

    loop(t) {
        if (!this.running) return;
        const dt = Math.min(0.05, (t - this._lastT) / 1000);
        this._lastT = t;
        this.step(dt);
        this._draw();
        if (this.state === 'SHOOTING') this.updateHUD();
        requestAnimationFrame((tt) => this.loop(tt));
    }

    _draw() {
        const ctx = this.ctx;
        const W = this.W, H = this.H;
        ctx.save();
        if (this.shakeT && this.shakeT > 0) {
            this.shakeT -= 1 / 60;
            ctx.translate((Math.random() - 0.5) * this.shakeAmp, (Math.random() - 0.5) * this.shakeAmp);
        }
        // Hell gradient background
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#1a0504');
        bg.addColorStop(0.5, '#2c0a06');
        bg.addColorStop(1, '#0a0202');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        // Glow embers / runes
        ctx.fillStyle = 'rgba(255, 130, 60, 0.05)';
        for (let i = 0; i < 14; i++) {
            const ex = (i * 73) % W;
            const ey = (i * 41) % (H - 60);
            ctx.beginPath();
            ctx.arc(ex, ey, 2 + (i % 3), 0, Math.PI * 2);
            ctx.fill();
        }

        // Lava defeat line
        const ly = this.defeatLineY;
        const lg = ctx.createLinearGradient(0, ly - 5, 0, ly + 6);
        lg.addColorStop(0, 'rgba(255, 180, 70, 0.9)');
        lg.addColorStop(0.5, 'rgba(255, 90, 30, 0.95)');
        lg.addColorStop(1, 'rgba(80, 0, 0, 0)');
        ctx.fillStyle = lg;
        ctx.fillRect(0, ly - 5, W, 12);
        ctx.fillStyle = 'rgba(255, 90, 20, 0.18)';
        ctx.fillRect(0, ly + 4, W, 28);

        // Blocks
        for (const b of this.blocks) this._drawBlock(ctx, b);

        // Balls + trails
        for (const ball of this.balls) {
            for (const t of ball.trail) {
                ctx.globalAlpha = 0.55;
                ctx.fillStyle = '#ff6020';
                ctx.beginPath();
                ctx.arc(t.x, t.y, 5, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            if (ball.active) this._drawFireball(ctx, ball);
        }

        this._drawCannon(ctx);
        if (this.state === 'AIMING') this._drawAimLine(ctx);

        // Particles on top
        for (const p of this.particles) {
            ctx.globalAlpha = Math.max(0, p.life / 0.8);
            if (p.kind === 'spark')      ctx.fillStyle = '#ffd060';
            else if (p.kind === 'hit')  ctx.fillStyle = '#ff7040';
            else if (p.kind === 'destroy') { ctx.fillStyle = (Math.random() < 0.5) ? '#ff8030' : '#702010'; }
            else if (p.kind === 'bomb')  ctx.fillStyle = '#ff4020';
            else if (p.kind === 'bonus') ctx.fillStyle = '#ffd060';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    _drawBlock(ctx, b) {
        const x = b.x, y = b.y, w = b.w, h = b.h;
        const bodyColor = b.type === 'bomb' ? '#400808'
                       : b.type === 'ballBonus' ? '#3a2010'
                       : '#1f0a08';
        const strokeColor = b.type === 'bomb' ? '#ff4020'
                          : b.type === 'ballBonus' ? '#ffd060'
                          : '#6a2010';
        ctx.fillStyle = bodyColor;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.5;
        this._roundRect(ctx, x - w / 2, y - h / 2, w, h, 6);
        ctx.fill();
        ctx.stroke();

        // Cracks: glow brighter when HP low
        const dmgRatio = 1 - b.hp / Math.max(1, b.maxHp);
        const glowAlpha = (0.35 + dmgRatio * 0.65).toFixed(2);
        ctx.strokeStyle = 'rgba(255, 140, 50, ' + glowAlpha + ')';
        ctx.lineWidth = 1 + dmgRatio * 1.4;
        ctx.beginPath();
        const s = b.seed;
        for (let i = 0; i < 3; i++) {
            const dx = (((s * (i + 1) * 31) % 100) / 100) - 0.5;
            const dy = (((s * (i + 2) * 41) % 100) / 100) - 0.5;
            const cx = x + dx * w / 2;
            const cy = y + dy * h / 2;
            ctx.moveTo(cx - 4, cy - 4); ctx.lineTo(cx + 4, cy + 4);
            ctx.moveTo(cx - 4, cy + 4); ctx.lineTo(cx + 4, cy - 4);
        }
        ctx.stroke();

        ctx.font = 'bold 13px Trebuchet MS';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (b.type === 'bomb') {
            ctx.fillStyle = '#ff4020'; ctx.font = 'bold 16px serif';
            ctx.fillText('☠', x, y);
        } else if (b.type === 'ballBonus') {
            ctx.fillStyle = '#ffd060'; ctx.font = 'bold 14px serif';
            ctx.fillText('+⚔', x, y);
        } else {
            ctx.fillStyle = 'rgba(255, 220, 180, 0.95)';
            ctx.fillText(b.hp + '/' + b.maxHp, x, y);
        }
    }

    _drawFireball(ctx, ball) {
        const halo = ctx.createRadialGradient(ball.x, ball.y, 1, ball.x, ball.y, 14);
        halo.addColorStop(0, 'rgba(255, 200, 90, 0.95)');
        halo.addColorStop(0.4, 'rgba(255, 120, 30, 0.85)');
        halo.addColorStop(1, 'rgba(255, 60, 0, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(ball.x, ball.y, 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff8d0';
        ctx.beginPath(); ctx.arc(ball.x, ball.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255, 80, 0, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(ball.x, ball.y, 7, 0, Math.PI * 2); ctx.stroke();
    }

    _drawCannon(ctx) {
        const cx = this.cannonX, cy = this.cannonY;
        ctx.save();
        const halo = ctx.createRadialGradient(cx, cy, 1, cx, cy, 60);
        halo.addColorStop(0, 'rgba(255, 100, 30, 0.4)');
        halo.addColorStop(1, 'rgba(255, 60, 0, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(cx, cy, 60, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = '#1a0604';
        ctx.beginPath();
        ctx.ellipse(cx, cy + 8, 38, 26, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#6a2010';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#ff5020';
        ctx.beginPath();
        ctx.arc(cx - 12, cy + 4, 5, 0, Math.PI * 2);
        ctx.arc(cx + 12, cy + 4, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.translate(cx, cy);
        ctx.rotate(this.cannonAngle);
        ctx.fillStyle = '#3a0a04';
        ctx.strokeStyle = '#ff4020';
        ctx.lineWidth = 2;
        this._roundRect(ctx, -10, -36, 20, 36, 4);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ff8040';
        ctx.beginPath(); ctx.arc(0, -36, 5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    _drawAimLine(ctx) {
        ctx.save();
        ctx.translate(this.cannonX, this.cannonY - 18);
        ctx.rotate(this.cannonAngle);
        ctx.strokeStyle = 'rgba(255, 200, 120, 0.65)';
        ctx.setLineDash([6, 8]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, -36);
        ctx.lineTo(0, -300);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    // ============ Static audio helpers (Web Audio, no samples) ============
    static _safeEnsure(audioCtx) {
        if (!audioCtx) return null;
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return audioCtx;
    }

    static playFireBallLaunch(audioCtx) {
        const c = HellfireBallsGame._safeEnsure(audioCtx); if (!c) return;
        const t = c.currentTime;
        // whistle-up tone for muzzle blast
        const o = c.createOscillator(); const g = c.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(880, t + 0.12);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.18, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.connect(g).connect(c.destination);
        o.start(t); o.stop(t + 0.2);
        // sub-thump
        const s = c.createOscillator(); const sg = c.createGain();
        s.type = 'sine';
        s.frequency.setValueAtTime(110, t);
        s.frequency.exponentialRampToValueAtTime(40, t + 0.1);
        sg.gain.setValueAtTime(0.0001, t);
        sg.gain.linearRampToValueAtTime(0.16, t + 0.02);
        sg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        s.connect(sg).connect(c.destination);
        s.start(t); s.stop(t + 0.15);
    }

    static playBlockHit(audioCtx) {
        const c = HellfireBallsGame._safeEnsure(audioCtx); if (!c) return;
        const t = c.currentTime;
        const o = c.createOscillator(); const g = c.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(950, t);
        o.frequency.exponentialRampToValueAtTime(380, t + 0.06);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.16, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        o.connect(g).connect(c.destination);
        o.start(t); o.stop(t + 0.09);
    }

    static playBlockDestroy(audioCtx, type) {
        const c = HellfireBallsGame._safeEnsure(audioCtx); if (!c) return;
        const t = c.currentTime;
        // explosion: filtered noise burst + low rumble
        const bufLen = 0.18 * c.sampleRate;
        const buf = c.createBuffer(1, bufLen, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            const k = 1 - i / bufLen;
            d[i] = (Math.random() * 2 - 1) * k * k;
        }
        const src = c.createBufferSource(); src.buffer = buf;
        const filt = c.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.setValueAtTime(type === 'bomb' ? 1800 : 1200, t);
        filt.Q.value = 1.2;
        const ng = c.createGain();
        ng.gain.setValueAtTime(type === 'bomb' ? 0.28 : 0.22, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        src.connect(filt).connect(ng).connect(c.destination);
        src.start(t); src.stop(t + 0.2);
        // sub rumble
        const s = c.createOscillator(); const sg = c.createGain();
        s.type = 'sine';
        s.frequency.setValueAtTime(140, t);
        s.frequency.exponentialRampToValueAtTime(45, t + 0.16);
        sg.gain.setValueAtTime(0.0001, t);
        sg.gain.linearRampToValueAtTime(0.20, t + 0.01);
        sg.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        s.connect(sg).connect(c.destination);
        s.start(t); s.stop(t + 0.24);
    }

    static playHellBombDetonate(audioCtx) {
        const c = HellfireBallsGame._safeEnsure(audioCtx); if (!c) return;
        const t = c.currentTime;
        // BIG filtered noise burst (350 ms) + sub-bass sine 100 -> 30 Hz
        const bufLen = 0.35 * c.sampleRate;
        const buf = c.createBuffer(1, bufLen, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            const k = 1 - i / bufLen;
            d[i] = (Math.random() * 2 - 1) * Math.pow(k, 0.7);
        }
        const src = c.createBufferSource(); src.buffer = buf;
        const filt = c.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.setValueAtTime(2400, t);
        filt.frequency.exponentialRampToValueAtTime(400, t + 0.32);
        filt.Q.value = 1.6;
        const ng = c.createGain();
        ng.gain.setValueAtTime(0.001, t);
        ng.gain.linearRampToValueAtTime(0.32, t + 0.02);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
        src.connect(filt).connect(ng).connect(c.destination);
        src.start(t); src.stop(t + 0.4);
        // deep rumble
        const s = c.createOscillator(); const sg = c.createGain();
        s.type = 'sine';
        s.frequency.setValueAtTime(100, t);
        s.frequency.exponentialRampToValueAtTime(30, t + 0.30);
        sg.gain.setValueAtTime(0.0001, t);
        sg.gain.linearRampToValueAtTime(0.26, t + 0.02);
        sg.gain.exponentialRampToValueAtTime(0.001, t + 0.40);
        s.connect(sg).connect(c.destination);
        s.start(t); s.stop(t + 0.42);
    }
}

// Инициализируем игру при загрузке страницы
window.addEventListener('load', () => {
    game.init();
});
