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
    _muted: false, // mute toggle for all sounds
    
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

        // Pre-load sketches from localStorage (survives page reload)
        try {
            const localRaw = localStorage.getItem('demonCatSketches');
            if (localRaw) {
                this.sketchPages = JSON.parse(localRaw);
                if (this.sketchPages.length > 0) {
                    console.log('Pre-loaded', this.sketchPages.length, 'sketches from localStorage');
                }
            }
        } catch (e) {
            this.sketchPages = [];
        }

        // Drawing editor
        this.editor = new DrawingEditor();

        // Canvas event handlers
        this.setupCanvasEvents();

        // AudioContext
        this.initAudio();
        
        // Restore mute state from localStorage
        try { this._muted = localStorage.getItem('demonCatMuted') === '1'; } catch (e) {}
        const muteBtn = document.getElementById('muteBtn');
        if (muteBtn) {
            muteBtn.textContent = this._muted ? '🔇' : '🔊';
            muteBtn.title = this._muted ? 'Включить звук' : 'Выключить звук';
        }

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

    // Генерация звука лопанья пузырька (мягкий)
    playMeow() {
        if (this._muted || !this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        const now = this.audioCtx.currentTime;
        // Основной «хлопок» — резкий спад частоты
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1800, now);
        osc.frequency.exponentialRampToValueAtTime(300, now + 0.06);
        gain.gain.setValueAtTime(0.14, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.13);
        // Второй пузырёк чуть позже и выше
        const osc2 = this.audioCtx.createOscillator();
        const gain2 = this.audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(2200, now + 0.04);
        osc2.frequency.exponentialRampToValueAtTime(400, now + 0.1);
        gain2.gain.setValueAtTime(0.08, now + 0.04);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc2.connect(gain2);
        gain2.connect(this.audioCtx.destination);
        osc2.start(now + 0.04);
        osc2.stop(now + 0.15);
    },

    // Звук серии лопающихся пузырьков (много маленьких)
    playPurr() {
        if (this._muted || !this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        const now = this.audioCtx.currentTime;
        // 6-8 крошечных пузырьков в быстрой последовательности
        for (let i = 0; i < 7; i++) {
            const t = now + i * 0.07 + Math.random() * 0.03;
            const freq = 2500 + Math.random() * 1500;
            const osc = this.audioCtx.createOscillator();
            const g = this.audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.exponentialRampToValueAtTime(freq * 0.15, t + 0.05);
            g.gain.setValueAtTime(0.05 + Math.random() * 0.04, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
            osc.connect(g);
            g.connect(this.audioCtx.destination);
            osc.start(t);
            osc.stop(t + 0.09);
        }
    },

    // Звук громкого лопанья большого пузыря
    playAngryMeow() {
        if (this._muted || !this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        const now = this.audioCtx.currentTime;
        // Большой пузырь — глубокий хлопок
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(900, now);
        osc.frequency.exponentialRampToValueAtTime(120, now + 0.07);
        gain.gain.setValueAtTime(0.16, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.16);
        // Брызги — несколько мелких пузырьков-осколков
        for (let i = 0; i < 4; i++) {
            const t = now + 0.02 + i * 0.03;
            const f = 3000 + Math.random() * 2000;
            const o = this.audioCtx.createOscillator();
            const g = this.audioCtx.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime(f, t);
            o.frequency.exponentialRampToValueAtTime(f * 0.1, t + 0.04);
            g.gain.setValueAtTime(0.07, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
            o.connect(g);
            g.connect(this.audioCtx.destination);
            o.start(t);
            o.stop(t + 0.07);
        }
    },

    // Переключить mute всех звуков
    toggleMute() {
        this._muted = !this._muted;
        const btn = document.getElementById('muteBtn');
        if (btn) {
            btn.textContent = this._muted ? '🔇' : '🔊';
            btn.title = this._muted ? 'Включить звук' : 'Выключить звук';
        }
        try { localStorage.setItem('demonCatMuted', this._muted ? '1' : '0'); } catch (e) {}
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
            this.savePetLocally();

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
                    this.savePetLocally();
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
            this.savePetLocally();
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

    // Сохранить питомца в localStorage (автосохранение)
    savePetLocally() {
        if (!this.pet) return;
        try {
            localStorage.setItem('demonCatPetData', JSON.stringify(this.pet));
        } catch (e) {}
    },

    // Восстановить питомца из localStorage (если API недоступен)
    loadPetLocally() {
        try {
            const data = localStorage.getItem('demonCatPetData');
            if (data) {
                const pet = JSON.parse(data);
                if (pet && pet.pet_id) {
                    this.pet = pet;
                    this.petId = pet.pet_id;
                    return true;
                }
            }
        } catch (e) {}
        return false;
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
            // Merge with any locally-saved sketches that the server may not have
            try {
                const localRaw = localStorage.getItem('demonCatSketches');
                if (localRaw) {
                    const localPages = JSON.parse(localRaw);
                    if (localPages.length > 0) {
                        // Merge: keep server entries, then append local-only ones
                        const serverIds = new Set(this.sketchPages.map(p => p.id));
                        for (const lp of localPages) {
                            if (!serverIds.has(lp.id)) {
                                this.sketchPages.push(lp);
                            }
                        }
                        console.log('Merged', this.sketchPages.length, 'sketches from API + localStorage');
                    }
                }
            } catch (e) {}
            this.renderNotebookPage();
        } catch (error) {
            console.error('Error loading notebook pages from API, trying localStorage:', error);
            try {
                const localData = localStorage.getItem('demonCatSketches');
                if (localData) {
                    this.sketchPages = JSON.parse(localData);
                    console.log('Loaded', this.sketchPages.length, 'sketches from localStorage');
                } else {
                    this.sketchPages = [];
                }
            } catch (e) {
                this.sketchPages = [];
            }
            this.renderNotebookPage();
        }
    },

    // Рендер текущей страницы блокнота (single-canvas, соответствует HTML).
    renderNotebookPage() {
        const canvas = document.getElementById('notebookCanvas');
        const labelEl = document.getElementById('pageTitle');
        const dateEl = document.getElementById('pageDate');
        const prevBtn = document.querySelector('.notebook-nav.prev');
        const nextBtn = document.querySelector('.notebook-nav.next');
        const pagesInfo = document.getElementById('pageNumber');
        
        this.renderSinglePage(canvas, labelEl, dateEl, this.currentPageIndex);
        
        const total = this.sketchPages.length;
        if (pagesInfo) {
            pagesInfo.textContent = total > 0
                ? `Страница ${this.currentPageIndex + 1} / ${total}`
                : 'Нет страниц';
        }
        if (prevBtn) prevBtn.disabled = (total === 0 || this.currentPageIndex <= 0);
        if (nextBtn) nextBtn.disabled = (total === 0 || this.currentPageIndex >= total - 1);
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

    // Перелистывание: одна страница с CSS-анимацией.
    flipPage(newIndex) {
        if (this.isFlipping) return;
        if (newIndex < 0 || newIndex >= this.sketchPages.length) return;
        this.isFlipping = true;
        
        const pageEl = document.getElementById('notebookPage');
        const direction = newIndex > this.currentPageIndex ? 'next' : 'prev';
        const flipClass = direction === 'next' ? 'flip-out-next' : 'flip-out-prev';
        
        if (pageEl) {
            pageEl.classList.remove('flip-out-next');
            pageEl.classList.remove('flip-out-prev');
            void pageEl.offsetWidth;  // рестарт CSS-анимации
            pageEl.classList.add(flipClass);
        }
        
        // В апексе анимации — заменяем содержимое страницы.
        setTimeout(() => {
            this.currentPageIndex = newIndex;
            this.renderNotebookPage();
        }, 220);
        
        // Полная очистка после анимации.
        setTimeout(() => {
            if (pageEl) {
                pageEl.classList.remove('flip-out-next');
                pageEl.classList.remove('flip-out-prev');
            }
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
            // Remove from localStorage too
            try {
                const ls = JSON.parse(localStorage.getItem('demonCatSketches') || '[]');
                const filtered = ls.filter(s => s.id !== page.id);
                localStorage.setItem('demonCatSketches', JSON.stringify(filtered));
            } catch (e) {}
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

    backToSketchList() {
        this.switchScreen('sketchScreen');
        // Render in-memory pages immediately so the just-saved sketch is visible.
        this.renderNotebookPage();
        // Background-refresh from API to pick up any server-side state changes.
        this.loadNotebookPages().catch(function () {});
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
        if (gameName === 'chef') {
            game.switchScreen('chefScreen');
            if (!this._chef) this._chef = new ChefGame(this);
            this._chef.start();
            return;
        }
        if (gameName === 'surf') {
            game.switchScreen('surfScreen');
            if (!this._surf) this._surf = new SurfGame(this);
            this._surf.start();
            return;
        }
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
            try { this.initSudoku(); } catch(e) { console.error('initSudoku failed:', e); }
        } else if (gameName === 'chess') {
            document.getElementById('gameTitle').textContent = '♟️ Шахматы';
            try {
                switchScreen('gameScreen');
                setTimeout(() => this.initChess(), 50);
            } catch(e) { console.error('initChess failed:', e); }
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
        if (!canvas) { console.error('initSudoku: gameCanvas not found'); return; }
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
        const gc = document.getElementById('gameControls');
        if (gc) gc.innerHTML =
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
    chessLastMove: null, // {from:{row,col}, to:{row,col}} tracking for highlighting
    
    // Цвета фигур по референсу
    chessColors: {
        white: { body: '#d8c8f0', light: '#e8d8ff', dark: '#b8a0d8', accent: '#9878b8', eyes: '#555', ear: '#c0a8e0' },
        black: { body: '#3a2a4a', light: '#5a4a6a', dark: '#2a1a3a', accent: '#1a0a2a', eyes: '#ddd', ear: '#4a3a5a' }
    },
    
    initChess() {
        const canvas = document.getElementById('gameCanvas');
        if (!canvas) { console.error('initChess: gameCanvas not found'); return; }
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
        this.chessAIDepth = d === 'easy' ? 2 : d === 'medium' ? 3 : 4;
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
                
                this.chessLastMove = {
                    from: { row: this.chessSelected.row, col: this.chessSelected.col },
                    to: { row, col }
                };
                
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
        
        this.chessLastMove = {
            from: { row: bestMove.fromR, col: bestMove.fromC },
            to: { row: bestMove.toR, col: bestMove.toC }
        };
        
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
        
        // Подсветка последнего хода
        if (this.chessLastMove) {
            const { from, to } = this.chessLastMove;
            ctx.strokeStyle = 'rgba(255, 215, 0, 0.8)';
            ctx.lineWidth = 4;
            // Подсветка клетки ОТКУДА
            ctx.strokeRect(from.col * size + 2, from.row * size + 2, size - 4, size - 4);
            // Подсветка клетки КУДА
            ctx.strokeRect(to.col * size + 2, to.row * size + 2, size - 4, size - 4);
            // Золотая точка в центре исходной клетки
            ctx.fillStyle = 'rgba(255, 215, 0, 0.4)';
            ctx.beginPath();
            ctx.arc(from.col * size + size/2, from.row * size + size/2, 8, 0, Math.PI * 2);
            ctx.fill();
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
        } else if (type === '♜' || type === '♖') {
            addSliding(1, 0); addSliding(-1, 0); addSliding(0, 1); addSliding(0, -1);
        } else if (type === '♞' || type === '♘') {
            const jumps = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
            jumps.forEach(([dr,dc]) => addIfValid(row+dr, col+dc));
        } else if (type === '♝' || type === '♗') {
            addSliding(1,1); addSliding(1,-1); addSliding(-1,1); addSliding(-1,-1);
        } else if (type === '♛' || type === '♕') {
            addSliding(1,0); addSliding(-1,0); addSliding(0,1); addSliding(0,-1);
            addSliding(1,1); addSliding(1,-1); addSliding(-1,1); addSliding(-1,-1);
        } else if (type === '♚' || type === '♔') {
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
        
        // ALWAYS save locally first - full offline fallback
        if (!Array.isArray(this.sketchPages)) this.sketchPages = [];
        const localSketch = {
            id: 'local-' + Date.now(),
            title: title,
            imageData: imageData,
            created_at: new Date().toISOString()
        };
        this.sketchPages.unshift(localSketch);
        this.currentPageIndex = 0;
        
        // Persist to localStorage
        try {
            const localSketches = JSON.parse(localStorage.getItem('demonCatSketches') || '[]');
            localSketches.unshift(localSketch);
            if (localSketches.length > 50) localSketches.length = 50;
            localStorage.setItem('demonCatSketches', JSON.stringify(localSketches));
        } catch (e) {}
        
        this.addNotification('Рисунок сохранён! 😻', 'success');
        
        // Возвращаемся в блокнот СРАЗУ (не ждём сервера) — иначе пользователь
        // не видит свой рисунок, пока идёт сетевой round-trip.
        this.backToSketchList();
        
        // Try to save to server as well (best-effort)
        try {
            const response = await fetch(API_BASE + '/sketches/' + this.petId + '/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, imageData })
            });
            if (response.ok) {
                const savedJson = await response.json().catch(function () { return {}; });
                const backendSketch = savedJson && (savedJson.sketch || savedJson);
                if (backendSketch && backendSketch.id) {
                    // Update local entry with real server ID
                    this.sketchPages[0].id = backendSketch.id;
                    // Update localStorage with server ID
                    try {
                        const ls = JSON.parse(localStorage.getItem('demonCatSketches') || '[]');
                        if (ls.length > 0) ls[0].id = backendSketch.id;
                        localStorage.setItem('demonCatSketches', JSON.stringify(ls));
                    } catch (e) {}
                }
            }
        } catch (error) {
            console.log('Server save unavailable, using local storage');
        }
        
        await this.getPetStatus();
        this.updateUI();
        this.backToSketchList();
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
        this.canvas.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'z') { this.undo(); e.preventDefault(); }
            if (e.ctrlKey && e.key === 'y') { this.redo(); e.preventDefault(); }
        });
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
        
        if (this.currentTool === 'fill') {
            this.floodFill(Math.round(x), Math.round(y));
            this.isDrawing = false;
            this.saveHistory();
            return;
        }
        
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
            // Paint a solid white circle so erasing is visually obvious (vs. transparent clearRect).
            this.ctx.fillStyle = 'white';
            this.ctx.beginPath();
            this.ctx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }

    floodFill(startX, startY) {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        const startIdx = (startY * w + startX) * 4;
        const srcR = data[startIdx], srcG = data[startIdx + 1], srcB = data[startIdx + 2];
        const hex = this.brushColor.slice(1);
        const fillR = parseInt(hex.slice(0, 2), 16);
        const fillG = parseInt(hex.slice(2, 4), 16);
        const fillB = parseInt(hex.slice(4, 6), 16);
        if (Math.abs(srcR - fillR) < 5 && Math.abs(srcG - fillG) < 5 && Math.abs(srcB - fillB) < 5) return;
        const stack = [[startX, startY]];
        const visited = new Set();
        while (stack.length > 0 && visited.size < 50000) {
            const [cx, cy] = stack.pop();
            const key = cx + ',' + cy;
            if (visited.has(key) || cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
            const idx = (cy * w + cx) * 4;
            if (Math.abs(data[idx] - srcR) > 30 ||
                Math.abs(data[idx + 1] - srcG) > 30 ||
                Math.abs(data[idx + 2] - srcB) > 30) continue;
            data[idx] = fillR;
            data[idx + 1] = fillG;
            data[idx + 2] = fillB;
            data[idx + 3] = 255;
            visited.add(key);
            stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
        ctx.putImageData(imageData, 0, 0);
        this.saveHistory();
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
        } else if (tool === 'fill') {
            document.getElementById('fillTool').classList.add('active');
        }
    }

    setBrushSize(size) {
        this.brushSize = size;
        document.getElementById('sizeDisplay').textContent = size;
    }

    setColor(color) {
        this.brushColor = color;
    }

    setTool(tool) {
        this.currentTool = tool;
        // Update active button styles
        if (this.canvas) {
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            const btn = document.getElementById(tool + 'Tool');
            if (btn) btn.classList.add('active');
        }
        this.canvas.style.cursor = tool === 'fill' ? 'crosshair' : 'crosshair';
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
        this.cols = 8;
        this.rows = 10;                       // max visible rows
        this.cellW = 0; this.cellH = 0;
        this.cellTopOffset = 40;
        this.defeatLineY = 0;
        this.blocks = [];
        this.balls = [];
        this.particles = [];
        this.ballCount = 1;                   // salvo size
        this.ballsInReserve = 3;              // carry over after pickups
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
        this.ballsInReserve = 3;
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
                w: this.cellW * 0.95, h: this.cellH * 0.95,
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
        this.trail = [];
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
        this.stopWaveLoop();
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
        const x = (clientX - rect.left) * (this.canvas.width / rect.width);
        const y = (clientY - rect.top) * (this.canvas.height / rect.height);
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
        const onMove = (e) => {
                this.aimEvent(e.clientX, e.clientY);
            };
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

// ========== MINIGAME: SEA SURF (3-Lane Endless Runner) ==========
class SurfGame {
    constructor(parent) {
        this.parent = parent;
        this.canvas = null;
        this.ctx = null;
        this.running = false;
        this._lastT = 0;
        this.W = 0;
        this.H = 0;

        // Player state
        this.lane = 1;          // 0=left, 1=center, 2=right
        this.targetLaneX = 0;   // visual x position (interpolated)
        this.playerX = 0;
        this.playerY = 0;
        this.laneX = [0, 0, 0]; // calculated in fitCanvas
        this.jumping = false;
        this.ducking = false;
        this.jumpT = 0;
        this.jumpDur = 1.1;
        this.duckT = 0;
        this.duckDur = 0.5;
        this.trampolining = false;
        this.trampolineT = 0;
        this.trampolineDur = 1.5;

        // World
        this.speed = 280;        // px/s
        this.baseSpeed = 140;
        this.maxSpeed = 600;
        this.distance = 0;
        this.coins = 0;
        this.bestDistance = 0;
        this.waterOffset = 0;

        // Objects
        this.obstacles = [];
        this.pearls = [];
        this.bonuses = [];
        this.particles = [];
        this.spawnTimer = 0;
        this.spawnInterval = 1.4;

        // Bonuses
        this.magnetTimer = 0;
        this.shieldActive = false;
        this.shieldFlash = 0;

        // Input
        this._swipeStart = null;
        this._handlers = [];
        this._keys = {};

        // High score
        try { this.bestDistance = parseFloat(localStorage.getItem('surfBestDist')) || 0; }
        catch(e) { this.bestDistance = 0; }
    }

    fitCanvas() {
        if (!this.canvas) return;
        const parent = this.canvas.parentElement;
        if (!parent) return;
        this.W = Math.min(parent.clientWidth - 20, 800);
        this.H = Math.min(parent.clientHeight - 20, 600);
        this.canvas.width = this.W;
        this.canvas.height = this.H;
        const w = this.W;
        this.laneX = [w * 0.18, w * 0.5, w * 0.82];
        this.playerX = this.laneX[this.lane];
        this.playerY = this.H * 0.78;
    }

    start() {
        const el = document.getElementById('surfScreen');
        if (!el) return;
        el.style.display = 'flex';
        this.canvas = document.getElementById('surfCanvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.fitCanvas();
        this.reset();
        this.startWaveLoop();
        this.running = true;
        this._lastT = performance.now();
        this.bindInput();
        this._onResize = () => this.fitCanvas();
        window.addEventListener('resize', this._onResize);
        requestAnimationFrame((t) => this.loop(t));
    }

    stop() {
        this.running = false;
        this.unbindInput();
        window.removeEventListener('resize', this._onResize);
        const el = document.getElementById('surfScreen');
        if (el) el.style.display = 'none';
    }

    reset() {
        this.lane = 1;
        this.playerX = this.laneX[1] || this.W * 0.5;
        this.playerY = this.H * 0.78;
        this.jumping = false;
        this.ducking = false;
        this.jumpT = 0;
        this.duckT = 0;
        this.trampolining = false;
        this.trampolineT = 0;
        this.speed = this.baseSpeed;
        this.distance = 0;
        this.coins = 0;
        this.obstacles = [];
        this.pearls = [];
        this.bonuses = [];
        this.particles = [];
        this.spawnTimer = 0;
        this.magnetTimer = 0;
        this.shieldActive = false;
        this.shieldFlash = 0;
        this.waterOffset = 0;
    }

    bindInput() {
        const c = this.canvas;
        if (!c) return;
        const self = this;
        const onKD = (e) => { self._keys[e.key] = true; self.handleKey(e.key); };
        const onKU = (e) => { self._keys[e.key] = false; };
        const onTS = (e) => {
            if (!e.touches || e.touches.length === 0) return;
            const t = e.touches[0];
            self._swipeStart = { x: t.clientX, y: t.clientY };
        };
        const onTE = (e) => {
            if (!self._swipeStart) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - self._swipeStart.x;
            const dy = t.clientY - self._swipeStart.y;
            const adx = Math.abs(dx), ady = Math.abs(dy);
            if (Math.max(adx, ady) < 20) return;
            if (adx > ady) {
                if (dx > 0) self.moveLane(1); else self.moveLane(-1);
            } else {
                if (dy < 0) self.jump(); else self.duck();
            }
            self._swipeStart = null;
            e.preventDefault();
        };
        c.addEventListener('touchstart', onTS, { passive: false });
        c.addEventListener('touchend', onTE, { passive: false });
        document.addEventListener('keydown', onKD);
        document.addEventListener('keyup', onKU);
        this._handlers = [
            { el: c, ev: 'touchstart', fn: onTS },
            { el: c, ev: 'touchend', fn: onTE },
            { el: document, ev: 'keydown', fn: onKD },
            { el: document, ev: 'keyup', fn: onKU }
        ];
        const close = document.getElementById('surfClose');
        if (close) {
            const fn = () => { this.stop(); if (this.parent.switchScreen) this.parent.switchScreen('minigamesScreen'); };
            close.addEventListener('click', fn);
            this._handlers.push({ el: close, ev: 'click', fn });
        }
        const restart = document.getElementById('surfRestart');
        if (restart) {
            const fn = () => {
                document.getElementById('surfGameOver').style.display = 'none';
                this.reset(); this.running = true; this._lastT = performance.now();
                requestAnimationFrame((t) => this.loop(t));
            };
            restart.addEventListener('click', fn);
            this._handlers.push({ el: restart, ev: 'click', fn });
        }
    }

    unbindInput() {
        for (const h of this._handlers) {
            h.el.removeEventListener(h.ev, h.fn);
        }
        this._handlers = [];
    }

    handleKey(key) {
        if (key === 'ArrowLeft' || key === 'a') this.moveLane(-1);
        if (key === 'ArrowRight' || key === 'd') this.moveLane(1);
        if (key === 'ArrowUp' || key === 'w') this.jump();
        if (key === 'ArrowDown' || key === 's') this.duck();
    }

    moveLane(dir) {
        if (this.trampolining) { this.lane = Math.max(0, Math.min(2, this.lane + dir)); return; }
        this.lane = Math.max(0, Math.min(2, this.lane + dir));
    }

    // Звук прыжка (всплеск/свист)
    playJumpSound() {
        if (game._muted) return;
        const ctx = game.audioCtx;
        if (!ctx) return;
        const now = ctx.currentTime;
        // Свист прыжка — резкий подъём частоты
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.exponentialRampToValueAtTime(800, now + 0.08);
        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.25);
    }

    // Звук сбора монеты (короткий звонкий пинг)
    playCoinSound() {
        if (game._muted) return;
        const ctx = game.audioCtx;
        if (!ctx) return;
        const now = ctx.currentTime;
        // Две быстрые ноты: высокая → ещё выше
        for (let i = 0; i < 2; i++) {
            const t = now + i * 0.06;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1200 + i * 800, t);
            osc.frequency.exponentialRampToValueAtTime(2000 + i * 1000, t + 0.05);
            gain.gain.setValueAtTime(0.08, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t);
            osc.stop(t + 0.15);
        }
    }

    // Фоновый шум волн (тихий, циклический, накладывается на другие звуки)
    _waveInterval = null;

    playWaveSound() {
        if (game._muted) return;
        const ctx = game.audioCtx;
        if (!ctx) return;
        const now = ctx.currentTime;
        // Шум волны — белый шум через низкочастотный фильтр
        const bufferSize = 256;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 300;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.015, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        noise.start(now);
        noise.stop(now + 1);
    }

    startWaveLoop() {
        this.stopWaveLoop();
        const loop = () => {
            this.playWaveSound();
            this._waveInterval = setTimeout(loop, 800 + Math.random() * 600);
        };
        loop();
    }

    stopWaveLoop() {
        if (this._waveInterval) {
            clearTimeout(this._waveInterval);
            this._waveInterval = null;
        }
    }

    jump() {
        if (this.jumping || this.ducking || this.trampolining) return;
        this.jumping = true;
        this.jumpT = 0;
    }

    duck() {
        if (this.jumping || this.ducking || this.trampolining) return;
        this.ducking = true;
        this.duckT = 0;
        this.speed += 40;
    }

    // ---- SPAWNING ----
    spawnObstacle() {
        const types = ['reef', 'log', 'tallRock', 'whale', 'fish', 'crab', 'lifeRing'];
        // reef/log/crab/fish/lifeRing are JUMPABLE (currently).
        // tallRock + whale are DUCK-ONLY (very tall / wide low — cannot jump over).
        const weights = [0.20, 0.20, 0.10, 0.10, 0.10, 0.16, 0.14];
        const r = Math.random();
        let cum = 0, type = 'reef';
        for (let i = 0; i < types.length; i++) { cum += weights[i]; if (r < cum) { type = types[i]; break; } }
        const lane = Math.floor(Math.random() * 3);
        const y = -40;
        this.obstacles.push({ type, lane, x: this.laneX[lane], y, w: 50, h: 50, hit: false });
    }

    spawnPearls() {
        const count = 3 + Math.floor(Math.random() * 5);
        const lane = Math.floor(Math.random() * 3);
        const startY = -40;
        for (let i = 0; i < count; i++) {
            this.pearls.push({
                x: this.laneX[lane] + (Math.random() - 0.5) * 40,
                y: startY - i * 45,
                r: 8, collected: false, gold: Math.random() < 0.12
            });
        }
    }

    spawnBonus() {
        const types = ['magnet', 'shield', 'trampoline'];
        const type = types[Math.floor(Math.random() * 3)];
        const lane = Math.floor(Math.random() * 3);
        this.bonuses.push({ type, lane, x: this.laneX[lane], y: -40, r: 18, collected: false });
    }

    spawnParticles(x, y, color, count) {
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const s = 30 + Math.random() * 80;
            this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0.4 + Math.random() * 0.3, maxLife: 0.7, color });
        }
    }

    // ---- COLLISION ----
    playerHitbox() {
        const pw = 40, ph = this.ducking ? 30 : (this.jumping ? 60 : 70);
        const py = this.jumping ? this.playerY - 130 : (this.ducking ? this.playerY + 10 : this.playerY - 20);
        return { x: this.playerX - pw/2, y: py - ph/2, w: pw, h: ph };
    }

    rectsOverlap(a, b) {
        return (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
    }

    // ---- GAME LOOP ----
    loop(t) {
        if (!this.running) return;
        const dt = Math.min(0.05, (t - this._lastT) / 1000);
        this._lastT = t;
        this.step(dt);
        this.draw();
        requestAnimationFrame((tt) => this.loop(tt));
    }

    step(dt) {
        // Speed ramp
        this.speed = Math.min(this.maxSpeed, this.baseSpeed + this.distance * 0.012);
        this.distance += this.speed * dt;
        this.waterOffset = (this.waterOffset + this.speed * dt) % 60;

        // Lane interpolation
        const targetX = this.laneX[this.lane];
        this.playerX += (targetX - this.playerX) * Math.min(1, dt * 10);

        // Jump
        if (this.jumping) {
            this.jumpT += dt;
            if (this.jumpT >= this.jumpDur) { this.jumping = false; this.jumpT = 0; }
        }
        // Duck
        if (this.ducking) {
            this.duckT += dt;
            if (this.duckT >= this.duckDur) { this.ducking = false; this.duckT = 0; }
        }
        // Trampoline
        if (this.trampolining) {
            this.trampolineT += dt;
            if (this.trampolineT >= this.trampolineDur) { this.trampolining = false; this.trampolineT = 0; }
        }

        // Magnet timer
        if (this.magnetTimer > 0) {
            this.magnetTimer = Math.max(0, this.magnetTimer - dt);
        }
        // Shield flash
        if (this.shieldActive) this.shieldFlash += dt;

        // Move objects down (toward player)
        const moveDy = this.speed * dt;
        for (const o of this.obstacles) o.y += moveDy;
        for (const p of this.pearls) p.y += moveDy;
        for (const b of this.bonuses) b.y += moveDy;

        // Spawn
        this.spawnTimer += dt;
        const interval = Math.max(0.5, this.spawnInterval - this.distance * 0.0004);
        if (this.spawnTimer >= interval) {
            this.spawnTimer = 0;
            const r = Math.random();
            if (r < 0.55) this.spawnObstacle();
            else if (r < 0.85) this.spawnPearls();
            else this.spawnBonus();
        }

        // Collect pearls
        const ph = this.playerHitbox();
        for (const p of this.pearls) {
            if (p.collected) continue;
            const dist = Math.hypot(this.playerX - p.x, (this.playerY - 35) - p.y);
            const collectRange = this.magnetTimer > 0 ? 140 : 32;
            if (dist < collectRange) {
                p.collected = true;
                this.coins += p.gold ? 8 : 1;
                this.playCoinSound();
                this.spawnParticles(p.x, p.y, p.gold ? '#ffd700' : '#ffeef0', 4);
                if (this.magnetTimer > 0 && dist > 40) {
                    p.x += (this.playerX - p.x) * 0.3;
                    p.y += ((this.playerY - 35) - p.y) * 0.3;
                }
            }
        }

        // Collect bonuses
        for (const b of this.bonuses) {
            if (b.collected) continue;
            const dist = Math.hypot(this.playerX - b.x, (this.playerY - 35) - b.y);
            if (dist < 35) {
                b.collected = true;
                if (b.type === 'magnet') { this.magnetTimer = 10; this.spawnParticles(b.x, b.y, '#4dc9f6', 10); }
                else if (b.type === 'shield') { this.shieldActive = true; this.shieldFlash = 0; this.spawnParticles(b.x, b.y, '#7cfc00', 10); }
                else if (b.type === 'trampoline') { this.trampolining = true; this.trampolineT = 0; this.spawnParticles(b.x, b.y, '#ff8c00', 15); }
            }
        }

        // Collisions with obstacles
        for (const o of this.obstacles) {
            if (o.hit) continue;
            const ob = { x: o.x - o.w/2, y: o.y - o.h/2, w: o.w, h: o.h };
            const pb = this.playerHitbox();
            if (!this.rectsOverlap(pb, { x: o.x - o.w/2, y: o.y - o.h/2, w: o.w, h: o.h })) continue;

            let fatal = true;
            // Check if correct avoidance action is active
            if (o.type === 'log' && this.jumping) fatal = false;
            // Whale is wide+low — duck under it.
            if (o.type === 'whale' && this.ducking) fatal = false;
            // Tall rock is very tall — jumping cannot clear it, only ducking saves you.
            if (o.type === 'tallRock' && this.ducking) fatal = false;
            if (o.type === 'reef' || o.type === 'crab') {
                if (this.jumping) fatal = false;
            }
            if (o.type === 'fish' && this.jumping) { fatal = false; this.coins += 5; this.playJumpSound(); }
            if (o.type === 'lifeRing') fatal = false;
            if (this.trampolining) fatal = false;

            if (fatal && this.shieldActive) {
                this.shieldActive = false;
                this.spawnParticles(o.x, o.y, '#7cfc00', 20);
                fatal = false;
                o.hit = true;
            }

            if (fatal) {
                this.gameOver();
                return;
            }
        }

        // Update particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life -= dt;
            if (p.life <= 0) { this.particles.splice(i, 1); continue; }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += 120 * dt;
        }

        // Cleanup off-screen objects
        this.obstacles = this.obstacles.filter(o => o.y < this.H + 100 && !o.hit);
        this.pearls = this.pearls.filter(p => p.y < this.H + 60 && !p.collected);
        this.bonuses = this.bonuses.filter(b => b.y < this.H + 60 && !b.collected);

        // Update HUD
        this.updateHUD();
    }

    gameOver() {
        this.running = false;
        if (this.distance > this.bestDistance) {
            this.bestDistance = this.distance;
            try { localStorage.setItem('surfBestDist', this.bestDistance); } catch(e) {}
        }
        document.getElementById('surfGameOver').style.display = 'flex';
        document.getElementById('surfFinalDist').textContent = Math.floor(this.distance);
        document.getElementById('surfFinalCoins').textContent = this.coins;
    }

    updateHUD() {
        const $ = (id) => document.getElementById(id);
        const d = $('surfDist'), c = $('surfCoins'), m = $('surfMagnet'), s = $('surfShield');
        if (d) d.textContent = Math.floor(this.distance) + 'm';
        if (c) c.textContent = this.coins;
        if (m) m.style.display = this.magnetTimer > 0 ? 'inline' : 'none';
        if (s) s.style.display = this.shieldActive ? 'inline' : 'none';
    }

    // ---- RENDER ----
    draw() {
        const ctx = this.ctx;
        const W = this.W, H = this.H;
        if (!ctx) return;

        // Full dark demonic background (no sky/sea split)
        const bgGrad = ctx.createRadialGradient(W*0.5, H*0.3, 0, W*0.5, H*0.3, W*0.8);
        bgGrad.addColorStop(0, '#2a1030');
        bgGrad.addColorStop(0.4, '#1a0820');
        bgGrad.addColorStop(0.7, '#0e0515');
        bgGrad.addColorStop(1, '#060208');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        // Demonic embers particles
        const t = Date.now() / 1000;
        for (let i = 0; i < 12; i++) {
            const ex = W * (0.1 + ((i * 137 + Math.sin(t + i) * 50) % 80) / 100);
            const ey = H * (0.05 + ((i * 97 + Math.cos(t * 0.7 + i * 2) * 30) % 95) / 100);
            const er = 1.5 + Math.sin(t * 2 + i) * 1;
            ctx.fillStyle = `rgba(255, ${100 + Math.sin(t + i) * 50}, 0, ${0.3 + Math.sin(t + i) * 0.2})`;
            ctx.beginPath();
            ctx.arc(ex, ey, er, 0, Math.PI * 2);
            ctx.fill();
        }

        // Ground/lava glow at bottom
        const groundGrad = ctx.createLinearGradient(0, H * 0.85, 0, H);
        groundGrad.addColorStop(0, 'rgba(40,8,20,0)');
        groundGrad.addColorStop(0.3, 'rgba(60,10,30,0.3)');
        groundGrad.addColorStop(0.7, 'rgba(80,15,20,0.5)');
        groundGrad.addColorStop(1, 'rgba(120,20,15,0.7)');
        ctx.fillStyle = groundGrad;
        ctx.fillRect(0, H * 0.85, W, H * 0.15);

        // Floating ember particles
        for (let i = 0; i < 6; i++) {
            const fy = H * 0.88 + Math.sin(t * 1.5 + i * 2) * 12;
            ctx.fillStyle = `rgba(255, ${150 + Math.sin(t + i) * 50}, 50, 0.15)`;
            ctx.beginPath();
            ctx.arc(W * (0.1 + i * 0.16), fy, 4 + Math.sin(t * 2 + i) * 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Coin & distance HUD
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.roundRect(8, 8, 180, 34, 8);
        ctx.fill();
        ctx.fillStyle = '#ffd700';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('🦪 ' + this.coins, 18, 32);
        ctx.fillStyle = '#fff';
        ctx.font = '13px sans-serif';
        ctx.fillText('🏁 ' + Math.floor(this.distance) + 'м', 100, 32);
        ctx.textAlign = 'start';
        ctx.restore();

        // Waves
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 8; i++) {
            const wy = H * 0.50 + i * 28;
            ctx.beginPath();
            for (let x = 0; x <= W; x += 5) {
                const yy = wy + Math.sin((x + this.waterOffset) * 0.04 + i * 1.5) * 8;
                if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
            }
            ctx.stroke();
        }

        // Lane markers (buoy-like dashed lines)
        ctx.setLineDash([10, 20]);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 2;
        for (let ln = 1; ln <= 2; ln++) {
            const lx = this.laneX[0] + ln * (this.laneX[2] - this.laneX[0]) / 2;
            ctx.beginPath();
            ctx.moveTo(lx, H * 0.50);
            ctx.lineTo(lx, H);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // Draw pearls
        for (const p of this.pearls) {
            if (p.collected || p.y < -20) continue;
            ctx.fillStyle = p.gold ? '#ffd700' : '#f0e6f6';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = p.gold ? '#b8960b' : '#c8b8d0';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            // Shine
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.beginPath();
            ctx.arc(p.x - 2, p.y - 3, p.r * 0.35, 0, Math.PI * 2);
            ctx.fill();
        }

        // Draw bonuses
        for (const b of this.bonuses) {
            if (b.collected || b.y < -20) continue;
            const pulse = 1 + Math.sin(Date.now() / 300) * 0.2;
            if (b.type === 'magnet') {
                ctx.fillStyle = '#4dc9f6';
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.r * pulse, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 16px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('🧲', b.x, b.y + 5);
            } else if (b.type === 'shield') {
                const grad = ctx.createRadialGradient(b.x, b.y, b.r*0.3, b.x, b.y, b.r * pulse);
                grad.addColorStop(0, 'rgba(124,252,0,0.8)');
                grad.addColorStop(1, 'rgba(124,252,0,0)');
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.r * pulse, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 16px sans-serif';
                ctx.fillText('🛡', b.x, b.y + 5);
            } else if (b.type === 'trampoline') {
                ctx.fillStyle = '#ff8c00';
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.r * pulse, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 16px sans-serif';
                ctx.fillText('🔼', b.x, b.y + 5);
            }
            ctx.textAlign = 'start';
        }

        // Draw obstacles
        for (const o of this.obstacles) {
            if (o.y < -50) continue;
            ctx.save();
            ctx.translate(o.x, o.y);
            if (o.type === 'reef') this.drawReef(ctx, o);
            else if (o.type === 'log') this.drawLog(ctx, o);
            else if (o.type === 'tallRock') this.drawTallRock(ctx, o);
            else if (o.type === 'whale') this.drawWhale(ctx, o);
            else if (o.type === 'fish') this.drawFish(ctx, o);
            else if (o.type === 'crab') this.drawCrab(ctx, o);
            else if (o.type === 'lifeRing') this.drawLifeRing(ctx, o);
            ctx.restore();
        }

        // Draw player (surfer pet on board)
        this.drawPlayer(ctx);

        // Shield glow
        if (this.shieldActive) {
            const pulse = 1 + Math.sin(this.shieldFlash * 8) * 0.1;
            const grad = ctx.createRadialGradient(this.playerX, this.playerY - 30, 20, this.playerX, this.playerY - 30, 55 * pulse);
            grad.addColorStop(0, 'rgba(124,252,0,0.15)');
            grad.addColorStop(1, 'rgba(124,252,0,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(this.playerX, this.playerY - 30, 55 * pulse, 0, Math.PI * 2);
            ctx.fill();
        }

        // Magnet field
        if (this.magnetTimer > 0) {
            const pulse = 1 + Math.sin(Date.now() / 200) * 0.15;
            ctx.strokeStyle = 'rgba(77,201,246,0.4)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 10]);
            ctx.beginPath();
            ctx.arc(this.playerX, this.playerY - 30, 140 * pulse, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Particles
        for (const p of this.particles) {
            const a = p.life / p.maxLife;
            ctx.fillStyle = p.color.replace(')', ',' + a + ')').replace('rgb', 'rgba');
            if (!p.color.includes('rgba')) ctx.globalAlpha = a;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4 * a, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    drawCloud(ctx, x, y, scale) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        ctx.beginPath();
        ctx.arc(0, 0, 20, 0, Math.PI * 2);
        ctx.arc(25, -5, 25, 0, Math.PI * 2);
        ctx.arc(50, 0, 20, 0, Math.PI * 2);
        ctx.arc(20, 8, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    drawReef(ctx, o) {
        ctx.fillStyle = '#6b3a2a';
        ctx.beginPath();
        ctx.moveTo(-15, 15);
        ctx.lineTo(-8, -20);
        ctx.lineTo(0, -28);
        ctx.lineTo(8, -20);
        ctx.lineTo(15, 10);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#4a2010';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    drawLog(ctx, o) {
        ctx.fillStyle = '#8B6914';
        ctx.fillRect(-35, -8, 70, 16);
        ctx.strokeStyle = '#5a4508';
        ctx.lineWidth = 2;
        ctx.strokeRect(-35, -8, 70, 16);
        ctx.strokeStyle = '#6b5010';
        ctx.beginPath();
        ctx.moveTo(-20, -8); ctx.lineTo(-20, 8);
        ctx.moveTo(0, -8); ctx.lineTo(0, 8);
        ctx.moveTo(20, -8); ctx.lineTo(20, 8);
        ctx.stroke();
    }

    // Tall jagged rock — visually extends ~70px above center.
    // Unjumpable: only the duck action saves you.
    drawTallRock(ctx, o) {
        // Shadow at water
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.ellipse(8, 18, 32, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        // Main jagged spike (tall, extending up)
        ctx.fillStyle = '#3a342f';
        ctx.strokeStyle = '#1b1816';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-22, 22);
        ctx.lineTo(-12, 0);
        ctx.lineTo(-6, -30);
        ctx.lineTo(2, -60);
        ctx.lineTo(8, -40);
        ctx.lineTo(14, -10);
        ctx.lineTo(18, 5);
        ctx.lineTo(22, 22);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Highlight stripe
        ctx.fillStyle = 'rgba(180,180,190,0.35)';
        ctx.beginPath();
        ctx.moveTo(-2, -50);
        ctx.lineTo(2, -55);
        ctx.lineTo(7, -30);
        ctx.lineTo(4, -10);
        ctx.closePath();
        ctx.fill();
    }

    drawWhale(ctx, o) {
        ctx.fillStyle = '#3a5f8a';
        ctx.beginPath();
        ctx.ellipse(0, 0, 40, 18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#2a4a6a';
        ctx.beginPath();
        ctx.ellipse(0, 10, 30, 14, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(-25, -5, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(-25, -5, 2, 0, Math.PI * 2);
        ctx.fill();
        // Spout
        ctx.strokeStyle = '#a0d0f0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-10, -16);
        ctx.lineTo(-10, -28);
        ctx.stroke();
        ctx.fillStyle = '#a0d0f0';
        ctx.beginPath();
        ctx.arc(-10, -30, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    drawCrab(ctx, o) {
        ctx.fillStyle = '#e04030';
        ctx.beginPath();
        ctx.ellipse(0, 0, 20, 14, 0, 0, Math.PI * 2);
        ctx.fill();
        // Claws
        ctx.strokeStyle = '#e04030';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-22, -8); ctx.lineTo(-32, -18);
        ctx.moveTo(-32, -18); ctx.lineTo(-28, -22);
        ctx.moveTo(22, -8); ctx.lineTo(32, -18);
        ctx.moveTo(32, -18); ctx.lineTo(28, -22);
        ctx.stroke();
        // Eyes
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(-7, -6, 4, 0, Math.PI * 2);
        ctx.arc(7, -6, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(-7, -6, 2, 0, Math.PI * 2);
        ctx.arc(7, -6, 2, 0, Math.PI * 2);
        ctx.fill();
    }

    drawLifeRing(ctx, o) {
        ctx.strokeStyle = '#ff6020';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(0, 0, 22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(0, -3, 16, Math.PI * 0.4, Math.PI * 1.1);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 3, 16, Math.PI * 1.6, Math.PI * 0.4);
        ctx.stroke();
    }

    drawFish(ctx, o) {
        const bobY = Math.sin(Date.now() / 400 + o.x) * 6;
        ctx.save();
        ctx.translate(0, bobY);
        // Fish body
        ctx.fillStyle = '#ff6b9d';
        ctx.beginPath();
        ctx.ellipse(0, 0, 24, 11, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff4080';
        ctx.beginPath();
        ctx.moveTo(22, 0);
        ctx.lineTo(34, -10);
        ctx.lineTo(34, 10);
        ctx.closePath();
        ctx.fill();
        // Fin
        ctx.fillStyle = '#ff80a0';
        ctx.beginPath();
        ctx.moveTo(2, -10);
        ctx.lineTo(10, -18);
        ctx.lineTo(14, -8);
        ctx.closePath();
        ctx.fill();
        // Eye
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(-12, -3, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(-12, -3, 2.5, 0, Math.PI * 2);
        ctx.fill();
        // Jump hint
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('⬆', 0, -22);
        ctx.textAlign = 'start';
        ctx.restore();
    }

    drawPlayer(ctx) {
        const x = this.playerX;
        let y = this.playerY;
        if (this.jumping) {
            const t = this.jumpT / this.jumpDur;
            y -= Math.sin(t * Math.PI) * 130;
        }
        if (this.trampolining) {
            const t = this.trampolineT / this.trampolineDur;
            y -= Math.sin(t * Math.PI) * 140;
        }

        ctx.save();
        ctx.translate(x, y);

        // Surfboard
        ctx.fillStyle = '#f5a623';
        ctx.beginPath();
        ctx.moveTo(-35, 10);
        ctx.quadraticCurveTo(-20, 18, 20, 18);
        ctx.quadraticCurveTo(35, 14, 38, 8);
        ctx.quadraticCurveTo(30, 6, 20, 8);
        ctx.quadraticCurveTo(0, 4, -20, 8);
        ctx.quadraticCurveTo(-30, 6, -38, 8);
        ctx.quadraticCurveTo(-35, 10, -35, 10);
        ctx.fill();
        ctx.strokeStyle = '#d4891a';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Stripe
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-15, 11);
        ctx.lineTo(15, 11);
        ctx.stroke();

        // Body (demon cat style)
        const sc = 0.5;
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.ellipse(0, -8, 22 * sc * 2, 28 * sc * 2, 0, 0, Math.PI * 2);
        ctx.fill();

        // Belly
        ctx.fillStyle = '#ff9999';
        ctx.beginPath();
        ctx.ellipse(0, 2, 14 * sc * 2, 16 * sc * 2, 0, 0, Math.PI * 2);
        ctx.fill();

        // Head
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.arc(0, -30, 18 * sc * 2, 0, Math.PI * 2);
        ctx.fill();

        // Ears
        ctx.beginPath();
        ctx.moveTo(-12, -40);
        ctx.lineTo(-4, -55);
        ctx.lineTo(0, -38);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(12, -40);
        ctx.lineTo(4, -55);
        ctx.lineTo(0, -38);
        ctx.closePath();
        ctx.fill();

        // Eyes
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(-6, -34, 6 * sc * 2, 0, Math.PI * 2);
        ctx.arc(6, -34, 6 * sc * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(-6, -34, 3 * sc * 2, 0, Math.PI * 2);
        ctx.arc(6, -34, 3 * sc * 2, 0, Math.PI * 2);
        ctx.fill();

        // Nose
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.moveTo(0, -28);
        ctx.lineTo(-3, -25);
        ctx.lineTo(3, -25);
        ctx.closePath();
        ctx.fill();

        // Whiskers
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 1.5;
        for (let s = -1; s <= 1; s += 2) {
            ctx.beginPath();
            ctx.moveTo(s * 8, -28);
            ctx.lineTo(s * 22, -32);
            ctx.moveTo(s * 8, -26);
            ctx.lineTo(s * 22, -26);
            ctx.moveTo(s * 8, -24);
            ctx.lineTo(s * 22, -20);
            ctx.stroke();
        }

        // Water splash under board
        ctx.fillStyle = 'rgba(200,230,255,0.5)';
        ctx.beginPath();
        ctx.arc(-25, 20, 6, 0, Math.PI);
        ctx.arc(0, 22, 8, 0, Math.PI);
        ctx.arc(25, 20, 6, 0, Math.PI);
        ctx.fill();

        ctx.restore();
    }
}


// ========== MINIGAME: CHEF COOK (creative cooking sandbox) ==========
class ChefGame {
    constructor(parent) {
        this.parent = parent;
        this.canvas = null;
        this.ctx = null;
        this.W = 0;
        this.H = 0;
        this.stage = 0; // 0=select base, 1=customize, 2=feed
        this.base = null; // 'pizza', 'burger', 'cake'
        this.customStep = 0; // sub-step within customization
        this.ingredients = []; // placed ingredients on dish
        this.feedPieces = []; // pieces for feeding
        this.feedIndex = 0;
        this.dragItem = null;
        this.dragX = 0;
        this.dragY = 0;
        this.dragging = false;
        this._animFrame = null;
        this._lastT = 0;
        this.hoverR = 0;
        this.feedChewT = 0;
        this.feedReaction = null; // 'default','fire','belly','hearts'
        this.feedReactionT = 0;
        this.satiety = 0;
        this.scrollX = 0;
        this.maxScrollX = 0;
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.wasTap = false;
        this.sauceMode = null; // 'tomato','cheese' for pizza, 'ketchup','mustard','mayo' for burger
        this.glazeColor = null; // for cake
        this.frostingType = null; // for cake
        this.baked = false;

        // Ingredient definitions with tags
        this.allIngredients = {
            pizza: {
                sauces: [
                    {id:'tomato',name:'Томатный соус',emoji:'🍅',color:'#c0392b',tags:{savory:2}},
                    {id:'cheese_sauce',name:'Сырный соус',emoji:'🧀',color:'#f5deb3',tags:{creamy:2}}
                ],
                toppings: [
                    {id:'pepperoni',name:'Пепперони',emoji:'🍖',color:'#8b0000',tags:{spicy:2,meaty:1},count:10},
                    {id:'mushroom',name:'Грибы',emoji:'🍄',color:'#d2b48c',tags:{earthy:1},count:10},
                    {id:'cheese',name:'Сыр',emoji:'🧀',color:'#ffd700',tags:{creamy:2},count:10},
                    {id:'olives',name:'Оливки',emoji:'🫒',color:'#556b2f',tags:{savory:1},count:10},
                    {id:'greens',name:'Зелень',emoji:'🌿',color:'#228b22',tags:{fresh:1},count:8}
                ]
            },
            burger: {
                patties: [
                    {id:'meat',name:'Мясная котлета',emoji:'🥩',color:'#8b4513',tags:{meaty:2,size:2}},
                    {id:'fish',name:'Рыбная котлета',emoji:'🐟',color:'#f4a460',tags:{fishy:1,size:2}},
                    {id:'vegan',name:'Веганская котлета',emoji:'🥬',color:'#6b8e23',tags:{fresh:2,size:2}}
                ],
                layers: [
                    {id:'cheese_slice',name:'Сырный ломтик',emoji:'🧀',color:'#ffd700',tags:{creamy:1},count:8},
                    {id:'bacon',name:'Бекон',emoji:'🥓',color:'#cd5c5c',tags:{salty:2,spicy:1},count:6},
                    {id:'lettuce',name:'Салат',emoji:'🥬',color:'#32cd32',tags:{fresh:2},count:8},
                    {id:'tomato_slice',name:'Помидор',emoji:'🍅',color:'#dc143c',tags:{fresh:1},count:8},
                    {id:'onion_rings',name:'Лук кольца',emoji:'🧅',color:'#dda0dd',tags:{spicy:1},count:8}
                ],
                sauces: [
                    {id:'ketchup',name:'Кетчуп',emoji:'🫗',color:'#cc0000',tags:{sweet:1}},
                    {id:'mustard',name:'Горчица',emoji:'🫗',color:'#ffd700',tags:{spicy:1}},
                    {id:'mayo',name:'Майонез',emoji:'🫗',color:'#fffacd',tags:{creamy:1}}
                ]
            },
            cake: {
                glazeColors: [
                    {id:'pink',name:'Розовая',color:'#ff69b4'},
                    {id:'chocolate',name:'Шоколадная',color:'#5c3317'},
                    {id:'white',name:'Белая',color:'#fffafa'},
                    {id:'blue',name:'Голубая',color:'#87ceeb'},
                    {id:'yellow',name:'Жёлтая',color:'#ffd700'}
                ],
                frostings: [
                    {id:'strawberry',name:'Клубничный крем',emoji:'🍓',color:'#ff69b4',tags:{sweet:2}},
                    {id:'choc_cream',name:'Шоколадный крем',emoji:'🍫',color:'#5c3317',tags:{sweet:2}},
                    {id:'vanilla',name:'Ванильный крем',emoji:'🍦',color:'#f5f5dc',tags:{sweet:1}}
                ],
                toppings: [
                    {id:'berries',name:'Ягоды',emoji:'🫐',color:'#8b008b',tags:{sweet:1,fresh:1},count:15},
                    {id:'sprinkles',name:'Посыпка',emoji:'🌈',color:'#ff69b4',tags:{sweet:2},count:20},
                    {id:'gummy',name:'Мармеладки',emoji:'🐻',color:'#ff4500',tags:{sweet:2},count:10},
                    {id:'choc_fig',name:'Шок. фигурки',emoji:'🍫',color:'#8b4513',tags:{sweet:1},count:8},
                    {id:'candles',name:'Свечки',emoji:'🕯️',color:'#ff6347',tags:{festive:1},count:6}
                ]
            }
        };

        // Current available ingredients for the strip
        this.currentIngredients = [];
    }

    start() {
        const el = document.getElementById('chefScreen');
        if (!el) return;
        el.style.display = 'flex';
        this.canvas = document.getElementById('chefCanvas');
        if (!this.canvas) return;
        this.fitCanvas();
        this.ctx = this.canvas.getContext('2d');
        this.stage = 0;
        this.base = null;
        this.customStep = 0;
        this.ingredients = [];
        this.baked = false;
        this.satiety = 0;
        this.scrollX = 0;
        this.dragging = false;
        this.dragItem = null;
        this.showStage();
        this.bindInput();
        this._lastT = performance.now();
        this._animFrame = requestAnimationFrame((t) => this.loop(t));
    }

    stop() {
        if (this._animFrame) cancelAnimationFrame(this._animFrame);
        this._animFrame = null;
        this.unbindInput();
        const el = document.getElementById('chefScreen');
        if (el) el.style.display = 'none';
    }

    fitCanvas() {
        const el = document.getElementById('chefScreen');
        if (!el || !this.canvas) return;
        const rect = el.getBoundingClientRect();
        const w = rect.width || 600;
        const h = rect.height - 60 || 500;
        this.W = w;
        this.H = h;
        this.canvas.width = w;
        this.canvas.height = h;
    }

    showStage() {
        const d = (id, show) => { const e = document.getElementById(id); if(e) e.style.display = show ? 'flex' : 'none'; };
        d('chefBaseSelect', this.stage === 0);
        d('chefCustomize', this.stage === 1);
        d('chefFeedArea', this.stage === 2);
        if (this.stage === 1) this.setupCustomIngredients();
    }

    setupCustomIngredients() {
        const base = this.allIngredients[this.base];
        this.currentIngredients = [];
        if (this.base === 'pizza') {
            if (this.customStep === 0) {
                this.currentIngredients = base.sauces.map(s => ({...s, type:'sauce'}));
            } else if (this.customStep === 1) {
                this.currentIngredients = base.toppings.map(t => ({...t, type:'topping'}));
            }
        } else if (this.base === 'burger') {
            if (this.customStep === 0) {
                this.currentIngredients = base.patties.map(p => ({...p, type:'patty'}));
            } else if (this.customStep === 1) {
                this.currentIngredients = base.layers.map(l => ({...l, type:'layer'}));
            } else if (this.customStep === 2) {
                this.currentIngredients = base.sauces.map(s => ({...s, type:'burger_sauce'}));
            }
        } else if (this.base === 'cake') {
            if (this.customStep === 0) {
                this.currentIngredients = base.glazeColors.map(g => ({...g, type:'glaze_color'}));
            } else if (this.customStep === 1) {
                this.currentIngredients = base.frostings.map(f => ({...f, type:'frosting'}));
            } else if (this.customStep === 2) {
                this.currentIngredients = base.toppings.map(t => ({...t, type:'cake_topping'}));
            }
        }
        this.scrollX = 0;
        this.maxScrollX = Math.max(0, this.currentIngredients.length * 100 - this.W + 40);
    }

    // ---- INPUT ----
    bindInput() {
        this._onPD = (e) => this.onPointerDown(e);
        this._onPM = (e) => this.onPointerMove(e);
        this._onPU = (e) => this.onPointerUp(e);
        if (this.canvas) {
            this.canvas.addEventListener('pointerdown', this._onPD);
            this.canvas.addEventListener('pointermove', this._onPM);
            this.canvas.addEventListener('pointerup', this._onPU);
            this.canvas.addEventListener('pointerleave', this._onPU);
        }
    }

    unbindInput() {
        if (this.canvas) {
            this.canvas.removeEventListener('pointerdown', this._onPD);
            this.canvas.removeEventListener('pointermove', this._onPM);
            this.canvas.removeEventListener('pointerup', this._onPU);
            this.canvas.removeEventListener('pointerleave', this._onPU);
        }
    }

    onPointerDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        this.touchStartX = x;
        this.touchStartY = y;
        this.wasTap = true;

        if (this.stage === 2) {
            // Feeding: try to grab a piece
            for (let i = this.feedPieces.length - 1; i >= 0; i--) {
                const p = this.feedPieces[i];
                const dx = x - p.x;
                const dy = y - p.y;
                if (Math.sqrt(dx*dx + dy*dy) < p.r + 10) {
                    this.dragging = true;
                    this.dragItem = {index: i, piece: p};
                    this.dragX = x;
                    this.dragY = y;
                    return;
                }
            }
        }

        if (this.stage === 1) {
            // Customize: try to grab from ingredient strip or placed ingredient
            // Check strip first
            const stripY = this.H - 80;
            if (y > stripY && y < this.H) {
                const idx = Math.floor((x + this.scrollX) / 100);
                if (idx >= 0 && idx < this.currentIngredients.length) {
                    const ing = this.currentIngredients[idx];
                    const ix = idx * 100 - this.scrollX + 50;
                    if (x > ix - 45 && x < ix + 45) {
                        this.dragging = true;
                        this.dragItem = {ingredient: ing, fromStrip: true};
                        this.dragX = x;
                        this.dragY = y;
                        return;
                    }
                }
            }
            // Check placed ingredients (to move them)
            for (let i = this.ingredients.length - 1; i >= 0; i--) {
                const ing = this.ingredients[i];
                const dx = x - ing.x;
                const dy = y - ing.y;
                if (Math.sqrt(dx*dx + dy*dy) < 35) {
                    this.dragging = true;
                    this.dragItem = {index: i, ingredient: ing, fromStrip: false};
                    this.dragX = x;
                    this.dragY = y;
                    return;
                }
            }
        }
    }

    onPointerMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (Math.abs(x - this.touchStartX) > 5 || Math.abs(y - this.touchStartY) > 5) {
            this.wasTap = false;
        }
        if (this.dragging) {
            this.dragX = x;
            this.dragY = y;
        }
        this.hoverR = (this.stage === 2) ? this.feedMouthX() : 0;
    }

    onPointerUp(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this.dragging && this.dragItem && this.stage === 1) {
            // Drop ingredient on dish
            if (y < this.H - 30 && y > 5) {
                if (this.dragItem.fromStrip) {
                    const ing = Object.assign({}, this.dragItem.ingredient);
                    ing.x = x;
                    ing.y = y;
                    ing.order = this.ingredients.length;
                    this.ingredients.push(ing);
                } else {
                    // Move existing ingredient
                    this.ingredients[this.dragItem.index].x = x;
                    this.ingredients[this.dragItem.index].y = y;
                }
            } else if (!this.dragItem.fromStrip) {
                // Removed from dish (dragged to strip)
                this.ingredients.splice(this.dragItem.index, 1);
            }
        }

        if (this.dragging && this.dragItem && this.stage === 2) {
            // Feed piece to pet
            const mx = this.feedMouthX();
            const my = this.H * 0.38;
            const dx = x - mx;
            const dy = y - my;
            if (Math.sqrt(dx*dx + dy*dy) < 55) {
                // Fed successfully!
                this.feedPieces.splice(this.dragItem.index, 1);
                this.satiety = Math.min(100, this.satiety + 25);
                if (this.satiety >= 100) this.playHappySqueak();
                this.feedChewT = 1.0;
                this.playChomp();
                // Trigger reaction based on dish composition
                this.triggerReaction();
            }
        }

        this.dragging = false;
        this.dragItem = null;
    }

    feedMouthX() {
        return this.W * 0.5;
    }

    triggerReaction() {
        // Aggregate tags from all placed ingredients
        let totalSpicy = 0, totalSweet = 0, totalSize = 0, totalCount = this.ingredients.length;
        for (const ing of this.ingredients) {
            if (ing.tags) {
                totalSpicy += ing.tags.spicy || 0;
                totalSweet += ing.tags.sweet || 0;
                totalSize += ing.tags.size || 0;
            }
        }
        if (totalSpicy >= 3) {
            this.feedReaction = 'fire';
        } else if (totalSize >= 4 || totalCount >= 12) {
            this.feedReaction = 'belly';
        } else if (totalSweet >= 4) {
            this.feedReaction = 'hearts';
            this.satiety = 100;
        } else {
            this.feedReaction = 'default';
        }
        this.feedReactionT = 2.5;
    }

    // ---- SELECT BASE ----
    selectBase(which) {
        this.base = which;
        this.stage = 1;
        this.customStep = 0;
        this.ingredients = [];
        this.baked = false;
        this.sauceMode = null;
        this.glazeColor = null;
        this.frostingType = null;
        this.showStage();
    }

    nextStep() {
        const maxSteps = this.base === 'pizza' ? 3 : this.base === 'burger' ? 4 : 3;
        if (this.base === 'pizza' && this.customStep === 1) {
            // Bake pizza
            this.baked = true;
            this.playSizzle();
            this.customStep = 2;
            this.showStage();
            return;
        }
        if (this.customStep < maxSteps - 1) {
            this.customStep++;
            this.showStage();
        } else {
            this.goToFeed();
        }
    }

    goToFeed() {
        this.stage = 2;
        // Generate feed pieces from placed ingredients
        this.feedPieces = [];
        const cx = this.W * 0.35;
        const cy = this.H * 0.55;
        const totalPieces = Math.min(8, Math.max(3, Math.floor(this.ingredients.length / 2)));
        for (let i = 0; i < totalPieces; i++) {
            this.feedPieces.push({
                x: cx + (i % 4) * 60 - (Math.min(totalPieces, 4) * 30),
                y: cy + Math.floor(i / 4) * 60,
                r: 22,
                color: this.base === 'pizza' ? '#e8a850' : this.base === 'burger' ? '#c8956c' : '#f5c6d0'
            });
        }
        this.satiety = 0;
        this.feedReaction = null;
        this.feedReactionT = 0;
        this.showStage();
    }

    resetGame() {
        this.stage = 0;
        this.base = null;
        this.customStep = 0;
        this.ingredients = [];
        this.baked = false;
        this.feedPieces = [];
        this.satiety = 0;
        this.feedReaction = null;
        this.scrollX = 0;
        this.showStage();
    }

    // ---- ANIMATION LOOP ----
    loop(t) {
        if (!this.canvas || this.canvas.style.display === 'none') {
            this._animFrame = requestAnimationFrame((t2) => this.loop(t2));
            return;
        }
        const dt = Math.min((t - this._lastT) / 1000, 0.1);
        this._lastT = t;

        if (this.feedChewT > 0) this.feedChewT -= dt;
        if (this.feedReactionT > 0) this.feedReactionT -= dt;
        if (this.feedReactionT <= 0) this.feedReaction = null;

        this.draw();
        this._animFrame = requestAnimationFrame((t2) => this.loop(t2));
    }

    // ---- DRAW ----
    draw() {
        const ctx = this.ctx;
        const W = this.W, H = this.H;
        if (!ctx) return;

        // Background
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#fff8f0');
        bg.addColorStop(1, '#fdebd0');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        // Table pattern
        ctx.fillStyle = 'rgba(139,90,43,0.08)';
        for (let i = 0; i < W; i += 60) {
            for (let j = 0; j < H; j += 40) {
                ctx.fillRect(i, j, 58, 38);
            }
        }

        if (this.stage === 1) {
            this.drawCustomize(ctx, W, H);
        } else if (this.stage === 2) {
            this.drawFeeding(ctx, W, H);
        } else {
            // Stage 0 is DOM-based, but draw a cute background
            this.drawIdleBg(ctx, W, H);
        }
    }

    drawIdleBg(ctx, W, H) {
        ctx.fillStyle = '#fff';
        ctx.font = '60px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('👨‍🍳', W/2, H/2 - 20);
        ctx.font = '16px sans-serif';
        ctx.fillStyle = '#888';
        ctx.fillText('Выбери основу блюда ниже', W/2, H/2 + 40);
        ctx.textAlign = 'start';
    }

    drawCustomize(ctx, W, H) {
        // Draw the dish base
        const cx = W / 2;
        const cy = H * 0.38;

        if (this.base === 'pizza') {
            // Dough
            ctx.fillStyle = this.baked ? '#e8c070' : '#f5deb3';
            ctx.beginPath();
            ctx.ellipse(cx, cy, 140, 140, 0, 0, Math.PI * 2);
            ctx.fill();
            if (this.baked) {
                ctx.strokeStyle = '#c8956c';
                ctx.lineWidth = 8;
                ctx.stroke();
            }
            // Sauce layer if any sauce placed
            if (this.customStep >= 1) {
                ctx.fillStyle = this.ingredients.some(i => i.id === 'tomato') ? 'rgba(192,57,43,0.6)' : 'rgba(245,222,179,0.6)';
                ctx.beginPath();
                ctx.ellipse(cx, cy, 120, 120, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        } else if (this.base === 'burger') {
            // Bottom bun
            ctx.fillStyle = '#d4a054';
            ctx.beginPath();
            ctx.ellipse(cx, cy + 30, 110, 35, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#e8c070';
            ctx.beginPath();
            ctx.ellipse(cx, cy + 28, 100, 30, 0, 0, Math.PI * 2);
            ctx.fill();
            // Layers stack
            let stackY = cy - 10;
            const hasTopBun = this.ingredients.some(i => i.id === 'top_bun');
            for (const ing of this.ingredients) {
                ctx.fillStyle = ing.color;
                ctx.beginPath();
                ctx.ellipse(cx, stackY, 95, 14, 0, 0, Math.PI * 2);
                ctx.fill();
                stackY -= 10;
            }
            if (hasTopBun) {
                ctx.fillStyle = '#d4a054';
                ctx.beginPath();
                ctx.ellipse(cx, stackY - 10, 110, 30, 0, 0, Math.PI * 2);
                ctx.fill();
                // Sesame seeds
                ctx.fillStyle = '#fff';
                for (let i = 0; i < 8; i++) {
                    const sx = cx + Math.cos(i * 0.8) * 50;
                    const sy = stackY - 18 + Math.sin(i * 0.8) * 12;
                    ctx.beginPath();
                    ctx.arc(sx, sy, 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        } else if (this.base === 'cake') {
            // Cake base
            ctx.fillStyle = '#f5c6a0';
            ctx.fillRect(cx - 90, cy - 50, 180, 100);
            ctx.fillStyle = '#e8b890';
            ctx.fillRect(cx - 85, cy - 45, 170, 45);
            // Glaze
            if (this.glazeColor) {
                ctx.fillStyle = this.glazeColor;
                ctx.beginPath();
                ctx.ellipse(cx, cy - 35, 85, 20, 0, 0, Math.PI);
                ctx.fill();
                ctx.fillRect(cx - 85, cy - 50, 170, 20);
            }
            // Frosting dots on sides
            if (this.frostingType) {
                ctx.fillStyle = this.frostingType;
                for (let i = 0; i < 6; i++) {
                    const fx = cx - 80 + i * 32;
                    ctx.beginPath();
                    ctx.arc(fx, cy + 5, 10, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            // Placed toppings
            for (const ing of this.ingredients) {
                if (ing.type === 'cake_topping') {
                    ctx.fillStyle = ing.color;
                    ctx.beginPath();
                    ctx.arc(ing.x, ing.y, 12, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        // Draw placed toppings/freeform ingredients
        for (const ing of this.ingredients) {
            if (this.base === 'cake' && ing.type === 'cake_topping') continue; // drawn above
            const r = ing.type === 'sauce' || ing.type === 'glaze_color' ? 35 : 18;
            this.drawIngredientSprite(ctx, ing, ing.x, ing.y, r);
        }

        // Ingredient strip at bottom
        ctx.fillStyle = 'rgba(0,0,0,0.06)';
        ctx.fillRect(0, H - 85, W, 85);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, H - 85, W, 85);
        ctx.clip();
        for (let i = 0; i < this.currentIngredients.length; i++) {
            const ing = this.currentIngredients[i];
            const ix = i * 100 - this.scrollX + 50;
            if (ix < -60 || ix > W + 60) continue;
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.strokeStyle = '#ddd';
            ctx.lineWidth = 2;
            this.roundRect(ctx, ix - 40, H - 78, 80, 70, 10);
            ctx.fill();
            ctx.stroke();
            this.drawIngredientSprite(ctx, ing, ix, H - 50, 18);
            ctx.fillStyle = '#333';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(ing.name || '', ix, H - 8);
        }
        ctx.textAlign = 'start';
        ctx.restore();

        // Scroll indicator
        if (this.maxScrollX > 0 && this.scrollX > 0) {
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.beginPath();
            ctx.moveTo(15, H - 43);
            ctx.lineTo(5, H - 48);
            ctx.lineTo(5, H - 38);
            ctx.fill();
        }
        if (this.maxScrollX > 0 && this.scrollX < this.maxScrollX) {
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.beginPath();
            ctx.moveTo(W - 15, H - 43);
            ctx.lineTo(W - 5, H - 48);
            ctx.lineTo(W - 5, H - 38);
            ctx.fill();
        }

        // Drag preview
        if (this.dragging && this.dragItem && this.dragItem.ingredient) {
            ctx.globalAlpha = 0.7;
            this.drawIngredientSprite(ctx, this.dragItem.ingredient, this.dragX, this.dragY, 22);
            ctx.globalAlpha = 1;
        }

        // Step indicator
        const stepNames = this.base === 'pizza' ? ['Соус','Начинка','Готово!🍕'] :
                          this.base === 'burger' ? ['Котлета','Добавки','Соус','Готово!🍔'] :
                          ['Глазурь','Крем','Топпинги'];
        ctx.fillStyle = '#333';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        const stepLabel = stepNames[this.customStep] || '';
        ctx.fillText('Этап: ' + stepLabel, W/2, H - 90);
        ctx.fillText('Ингредиентов: ' + this.ingredients.length, W/2, H - 95);
        ctx.textAlign = 'start';
    }

    drawIngredientSprite(ctx, ing, x, y, r) {
        const name = (ing.name || '').toLowerCase();
        ctx.save();
        ctx.translate(x, y);
        const s = r / 18; // scale relative to default radius
        
        // Draw different shapes based on ingredient type
        if (name.includes('pepperoni') || name.includes('pep')) {
            // Round pepperoni slice
            ctx.fillStyle = '#cc3333';
            ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#aa2222';
            ctx.beginPath(); ctx.arc(-3*s, -3*s, 3*s, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(4*s, 2*s, 2.5*s, 0, Math.PI * 2); ctx.fill();
        } else if (name.includes('mushroom') || name.includes('гриб')) {
            // Mushroom cap
            ctx.fillStyle = '#c8a070';
            ctx.beginPath(); ctx.ellipse(0, -2*s, r*0.7, r*0.5, 0, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#e8d0b0';
            ctx.fillRect(-4*s, -2*s, 8*s, 8*s);
        } else if (name.includes('cheese') || name.includes('сыр')) {
            // Cheese wedge
            ctx.fillStyle = '#ffd700';
            ctx.beginPath(); ctx.moveTo(0, -r*0.7); ctx.lineTo(r*0.7, r*0.5); ctx.lineTo(-r*0.5, r*0.6); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#ffed4a';
            ctx.beginPath(); ctx.arc(-2*s, 2*s, 4*s, 0, Math.PI*2); ctx.fill();
        } else if (name.includes('olive') || name.includes('олив')) {
            // Olive
            ctx.fillStyle = '#2d5a27';
            ctx.beginPath(); ctx.ellipse(0, 0, r*0.5, r*0.7, 0, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#8b0000';
            ctx.beginPath(); ctx.arc(0, 0, 2*s, 0, Math.PI*2); ctx.fill();
        } else if (name.includes('bacon') || name.includes('бекон')) {
            // Bacon strip
            ctx.fillStyle = '#b54040';
            ctx.beginPath(); ctx.moveTo(-r*0.7, -3*s); ctx.quadraticCurveTo(0, -8*s, r*0.7, -3*s);
            ctx.quadraticCurveTo(r*0.8, 2*s, r*0.7, 6*s); ctx.quadraticCurveTo(0, 10*s, -r*0.7, 6*s);
            ctx.quadraticCurveTo(-r*0.8, 2*s, -r*0.7, -3*s); ctx.fill();
            ctx.strokeStyle = '#8b2020'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(-r*0.3, -5*s); ctx.lineTo(-r*0.2, 8*s); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(r*0.1, -6*s); ctx.lineTo(r*0.2, 8*s); ctx.stroke();
        } else if (name.includes('lettuce') || name.includes('салат') || name.includes('лист')) {
            // Lettuce leaf
            ctx.fillStyle = '#4caf50';
            ctx.beginPath(); ctx.ellipse(0, 0, r*0.9, r*0.4, 0.3, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#66bb6a';
            ctx.beginPath(); ctx.ellipse(-3*s, -2*s, r*0.6, r*0.25, -0.1, 0, Math.PI*2); ctx.fill();
            ctx.strokeStyle = '#388e3c'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(-r*0.7, 0); ctx.lineTo(r*0.7, 2*s); ctx.stroke();
        } else if (name.includes('tomato') || name.includes('помидор') || name.includes('томат')) {
            // Tomato slice
            ctx.fillStyle = '#e53935';
            ctx.beginPath(); ctx.arc(0, 0, r*0.7, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#ff5252';
            ctx.beginPath(); ctx.arc(0, 0, r*0.45, 0, Math.PI*2); ctx.fill();
            // Seeds
            ctx.fillStyle = '#ffab91';
            for (let i = 0; i < 4; i++) {
                const a = i * Math.PI/2 + 0.3;
                ctx.beginPath(); ctx.ellipse(Math.cos(a)*r*0.35, Math.sin(a)*r*0.35, 2, 3, a, 0, Math.PI*2); ctx.fill();
            }
        } else if (name.includes('onion') || name.includes('лук')) {
            // Onion ring
            ctx.strokeStyle = '#e1bee7'; ctx.lineWidth = 4*s;
            ctx.beginPath(); ctx.arc(0, 0, r*0.6, 0, Math.PI*2); ctx.stroke();
            ctx.strokeStyle = '#ce93d8'; ctx.lineWidth = 2*s;
            ctx.beginPath(); ctx.arc(0, 0, r*0.5, 0.2, Math.PI*1.8); ctx.stroke();
        } else if (name.includes('fish') || name.includes('рыб')) {
            // Fish patty
            ctx.fillStyle = '#d4a574';
            ctx.beginPath(); ctx.ellipse(0, 0, r*0.8, r*0.55, 0, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#c49464';
            ctx.beginPath(); ctx.arc(-3*s, -3*s, 4*s, 0, Math.PI*2); ctx.fill();
        } else if (name.includes('meat') || name.includes('мясн') || name.includes('котлет')) {
            // Meat patty
            ctx.fillStyle = '#6d4c41';
            ctx.beginPath(); ctx.ellipse(0, 0, r*0.85, r*0.5, 0, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#5d4037';
            ctx.beginPath(); ctx.arc(-4*s, -2*s, 3*s, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(5*s, 3*s, 2.5*s, 0, Math.PI*2); ctx.fill();
        } else if (name.includes('vegan') || name.includes('веган') || name.includes('зелен')) {
            // Vegan patty (green)
            ctx.fillStyle = '#66bb6a';
            ctx.beginPath(); ctx.ellipse(0, 0, r*0.85, r*0.5, 0, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#43a047';
            ctx.beginPath(); ctx.arc(-3*s, -2*s, 3*s, 0, Math.PI*2); ctx.fill();
        } else if (name.includes('ketchup') || name.includes('кетчуп')) {
            // Ketchup squiggle
            ctx.strokeStyle = '#d32f2f'; ctx.lineWidth = 4*s; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(-r*0.7, -r*0.3); ctx.quadraticCurveTo(0, -r*0.7, r*0.7, 0);
            ctx.quadraticCurveTo(r*0.3, r*0.5, -r*0.4, r*0.3); ctx.stroke();
        } else if (name.includes('mustard') || name.includes('горчиц')) {
            // Mustard squiggle
            ctx.strokeStyle = '#fdd835'; ctx.lineWidth = 3*s; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(-r*0.6, r*0.2); ctx.quadraticCurveTo(0, -r*0.5, r*0.6, -r*0.1);
            ctx.quadraticCurveTo(r*0.3, r*0.4, -r*0.3, r*0.5); ctx.stroke();
        } else if (name.includes('mayo') || name.includes('майонез')) {
            // Mayo dollop
            ctx.fillStyle = '#fff9c4';
            ctx.beginPath(); ctx.arc(0, 0, r*0.5, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#fffde7';
            ctx.beginPath(); ctx.arc(-3*s, -3*s, 3*s, 0, Math.PI*2); ctx.fill();
        } else if (name.includes('sauce') || name.includes('соус')) {
            // Sauce spread
            ctx.fillStyle = ing.color || '#e53935';
            ctx.globalAlpha = 0.7;
            ctx.beginPath(); ctx.arc(0, 0, r*0.9, 0, Math.PI*2); ctx.fill();
            ctx.globalAlpha = 0.4;
            ctx.beginPath(); ctx.arc(5*s, -5*s, r*0.5, 0, Math.PI*2); ctx.fill();
            ctx.globalAlpha = 1;
        } else if (name.includes('berry') || name.includes('ягод')) {
            // Berry
            ctx.fillStyle = '#e53935';
            ctx.beginPath(); ctx.arc(0, 0, r*0.6, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#ff7043';
            ctx.beginPath(); ctx.arc(-2*s, -2*s, 2*s, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#4caf50';
            ctx.beginPath(); ctx.arc(0, -r*0.6, 1.5*s, 0, Math.PI*2); ctx.fill();
        } else if (name.includes('sprinkle') || name.includes('посып')) {
            // Sprinkles - colorful dots
            const colors = ['#ff5252', '#448aff', '#ffeb3b', '#69f0ae', '#e040fb'];
            for (let i = 0; i < 8; i++) {
                const a = i * Math.PI/4 + Math.sin(Date.now()/1000) * 0.2;
                ctx.fillStyle = colors[i % 5];
                ctx.beginPath(); ctx.arc(Math.cos(a)*r*0.7, Math.sin(a)*r*0.7, 3*s, 0, Math.PI*2); ctx.fill();
            }
        } else if (name.includes('gummy') || name.includes('мармелад') || name.includes('мишк')) {
            // Gummy bear shape
            ctx.fillStyle = '#ff8a65';
            ctx.beginPath(); ctx.ellipse(0, 4*s, r*0.4, r*0.5, 0, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(0, -5*s, r*0.35, 0, Math.PI*2); ctx.fill();
            // Ears
            ctx.beginPath(); ctx.arc(-6*s, -10*s, 3*s, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(6*s, -10*s, 3*s, 0, Math.PI*2); ctx.fill();
        } else if (name.includes('chocolate') || name.includes('шоколад') || name.includes('фигур')) {
            // Chocolate figure
            ctx.fillStyle = '#5d4037';
            ctx.beginPath(); ctx.rect(-r*0.5, -r*0.6, r, r*1.2); ctx.fill();
            ctx.fillStyle = '#795548';
            ctx.beginPath(); ctx.rect(-r*0.3, -r*0.4, r*0.3, r*0.3); ctx.fill();
            ctx.beginPath(); ctx.rect(r*0.1, -r*0.2, r*0.2, r*0.4); ctx.fill();
        } else if (name.includes('candle') || name.includes('свечк') || name.includes('свеч')) {
            // Candle
            ctx.fillStyle = '#ff7043';
            ctx.fillRect(-2*s, -r*0.4, 4*s, r*0.8);
            ctx.fillStyle = '#ffcc80';
            ctx.beginPath(); ctx.arc(0, -r*0.5, 3*s, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#ffeb3b';
            ctx.beginPath(); ctx.arc(0, -r*0.5, 1.5*s, 0, Math.PI*2); ctx.fill();
            ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(0, -r*0.5); ctx.lineTo(0, -r*0.7); ctx.stroke();
        } else if (name.includes('cream') || name.includes('крем') || name.includes('frost') || name.includes('глазурь')) {
            // Frosting swirl
            ctx.fillStyle = ing.color || '#f8bbd0';
            ctx.beginPath(); ctx.arc(0, 0, r*0.7, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.globalAlpha = 0.4;
            ctx.beginPath(); ctx.arc(-4*s, -4*s, r*0.3, 0, Math.PI*2); ctx.fill();
            ctx.globalAlpha = 1;
        } else if (name.includes('glaze') || name.includes('глазур')) {
            // Glaze coating
            ctx.fillStyle = ing.color || '#f48fb1';
            ctx.globalAlpha = 0.6;
            ctx.beginPath(); ctx.arc(0, 0, r*1.0, 0, Math.PI*2); ctx.fill();
            ctx.globalAlpha = 0.3;
            ctx.beginPath(); ctx.arc(3*s, -5*s, r*0.6, 0, Math.PI*2); ctx.fill();
            ctx.globalAlpha = 1;
        } else if (name.includes('greens') || name.includes('зелень') || name.includes('herb')) {
            // Herb sprigs
            ctx.strokeStyle = '#4caf50'; ctx.lineWidth = 2*s;
            ctx.beginPath(); ctx.moveTo(0, r*0.5); ctx.quadraticCurveTo(-r*0.3, -r*0.2, -r*0.7, -r*0.5); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, r*0.5); ctx.quadraticCurveTo(r*0.2, -r*0.3, r*0.6, -r*0.6); ctx.stroke();
            ctx.fillStyle = '#66bb6a';
            ctx.beginPath(); ctx.arc(-r*0.7, -r*0.5, 3*s, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(r*0.6, -r*0.6, 3*s, 0, Math.PI*2); ctx.fill();
        } else {
            // Default: draw a simple detailed ingredient
            ctx.fillStyle = ing.color || '#e0e0e0';
            ctx.beginPath(); ctx.arc(0, 0, r*0.7, 0, Math.PI*2); ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 1.5*s;
            ctx.beginPath(); ctx.arc(0, 0, r*0.7, 0, Math.PI*2); ctx.stroke();
            // Shine
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.beginPath(); ctx.arc(-3*s, -4*s, 4*s, 0, Math.PI*2); ctx.fill();
        }
        ctx.restore();
    }

    drawFeeding(ctx, W, H) {

        // Pet sitting at table
        const px = W * 0.68;
        const py = H * 0.32;

        // Pet body
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.ellipse(px, py + 20, 55, 65, 0, 0, Math.PI * 2);
        ctx.fill();

        // Belly (inflated if reaction=belly)
        const bellyScale = this.feedReaction === 'belly' ? 1.4 : 1;
        ctx.fillStyle = '#ff9999';
        ctx.beginPath();
        ctx.ellipse(px, py + 35, 40 * bellyScale, 45 * bellyScale, 0, 0, Math.PI * 2);
        ctx.fill();

        // Head
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.arc(px, py - 55, 40, 0, Math.PI * 2);
        ctx.fill();

        // Ears
        ctx.beginPath();
        ctx.moveTo(px - 28, py - 78);
        ctx.lineTo(px - 15, py - 105);
        ctx.lineTo(px - 5, py - 72);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(px + 28, py - 78);
        ctx.lineTo(px + 15, py - 105);
        ctx.lineTo(px + 5, py - 72);
        ctx.closePath();
        ctx.fill();

        // Eyes (happy when feeding)
        if (this.feedChewT > 0 || this.feedReaction === 'hearts') {
            ctx.fillStyle = '#000';
            ctx.beginPath();
            ctx.arc(px - 14, py - 66, 4, 0, Math.PI);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(px + 14, py - 66, 4, 0, Math.PI);
            ctx.fill();
        } else {
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(px - 14, py - 66, 12, 0, Math.PI * 2);
            ctx.arc(px + 14, py - 66, 12, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#000';
            ctx.beginPath();
            ctx.arc(px - 14, py - 66, 5, 0, Math.PI * 2);
            ctx.arc(px + 14, py - 66, 5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Mouth (wide open for belly reaction)
        const mouthW = this.feedReaction === 'belly' ? 28 : 18;
        const mouthH = this.feedChewT > 0.3 ? 12 : 6;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(px, py - 48, mouthW, mouthH, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.ellipse(px, py - 46, mouthW - 4, mouthH - 2, 0, 0, Math.PI * 2);
        ctx.fill();

        // Fire breath
        if (this.feedReaction === 'fire') {
            const ft = 1 - (this.feedReactionT / 2.5);
            ctx.fillStyle = `rgba(255,100,0,${0.8 - ft * 0.8})`;
            ctx.beginPath();
            ctx.moveTo(px + 20, py - 48);
            ctx.quadraticCurveTo(px + 60, py - 70 - ft * 20, px + 80 - ft * 20, py - 50);
            ctx.quadraticCurveTo(px + 60, py - 35, px + 20, py - 46);
            ctx.fill();
            ctx.fillStyle = `rgba(255,200,0,${0.6 - ft * 0.6})`;
            ctx.beginPath();
            ctx.moveTo(px + 18, py - 48);
            ctx.quadraticCurveTo(px + 50, py - 60 - ft * 10, px + 60 - ft * 15, py - 48);
            ctx.quadraticCurveTo(px + 50, py - 40, px + 18, py - 46);
            ctx.fill();
        }

        // Hearts
        if (this.feedReaction === 'hearts') {
            for (let i = 0; i < 5; i++) {
                const hx = px + Math.cos(i * 1.3 + Date.now() / 800) * 80;
                const hy = py - 90 + Math.sin(i * 0.9 + Date.now() / 600) * 60;
                ctx.fillStyle = '#ff4080';
                ctx.font = '20px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('❤️', hx, hy);
                ctx.textAlign = 'start';
            }
        }

        // Paws
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.ellipse(px - 25, py + 30, 18, 12, 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(px + 25, py + 30, 18, 12, -0.3, 0, Math.PI * 2);
        ctx.fill();

        // Table
        ctx.fillStyle = '#8b5a2b';
        ctx.fillRect(W * 0.08, py + 55, W * 0.6, 20);
        ctx.fillStyle = '#a0522d';
        ctx.fillRect(W * 0.1, py + 75, W * 0.08, H - py - 75);
        ctx.fillRect(W * 0.6, py + 75, W * 0.08, H - py - 75);

        // Feed pieces on table
        if (this.dragging && this.dragItem && this.dragItem.piece) {
            ctx.globalAlpha = 0.6;
            ctx.fillStyle = this.dragItem.piece.color;
            ctx.beginPath();
            ctx.arc(this.dragX, this.dragY, this.dragItem.piece.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        for (let i = 0; i < this.feedPieces.length; i++) {
            const p = this.feedPieces[i];
            if (this.dragging && this.dragItem && this.dragItem.index === i) continue;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // Satiety bar
        ctx.fillStyle = '#ddd';
        this.roundRect(ctx, W * 0.1, H - 35, W * 0.8, 20, 10);
        ctx.fill();
        const barW = (W * 0.8 - 4) * (this.satiety / 100);
        const barGrad = ctx.createLinearGradient(W * 0.1, 0, W * 0.1 + barW, 0);
        barGrad.addColorStop(0, '#ff6b6b');
        barGrad.addColorStop(1, '#4ecb71');
        ctx.fillStyle = barGrad;
        this.roundRect(ctx, W * 0.1 + 2, H - 33, barW, 16, 8);
        ctx.fill();
        ctx.fillStyle = '#333';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Сытость: ' + Math.floor(this.satiety) + '%', W/2, H - 20);
        ctx.textAlign = 'start';

        // Instruction
        if (this.feedPieces.length === 0 && this.satiety >= 100) {
            ctx.fillStyle = '#2ecc71';
            ctx.font = 'bold 18px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('🎉 Ням-ням! Питомец сыт и доволен! 🎉', W/2, H/2 + 80);
            ctx.textAlign = 'start';
        } else if (this.feedPieces.length > 0) {
            ctx.fillStyle = '#888';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Перетащи кусочек в рот питомцу →', W * 0.35, H * 0.25);
            ctx.textAlign = 'start';
        }
    }

    roundRect(ctx, x, y, w, h, r) {
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

    // ===== SOUND EFFECTS =====
    _audioCtx() {
        if (!this.__actx) {
            try { this.__actx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
        }
        if (this.__actx && this.__actx.state === 'suspended') this.__actx.resume();
        return this.__actx;
    }

    // Sizzle: pizza baking sound (hissing/steam)
    playSizzle() {
        if (game._muted) return;
        const ctx = this._audioCtx();
        if (!ctx) return;
        const now = ctx.currentTime;
        // White-noise hiss filtered through a bandpass
        const buf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(3000, now);
        bp.frequency.exponentialRampToValueAtTime(800, now + 1.0);
        bp.Q.value = 0.5;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 1.2);
        src.connect(bp);
        bp.connect(gain);
        gain.connect(ctx.destination);
        src.start(now);
        src.stop(now + 1.3);
    }

    // Chomp: chewing sound when a piece is eaten
    playChomp() {
        if (game._muted) return;
        const ctx = this._audioCtx();
        if (!ctx) return;
        const now = ctx.currentTime;
        // Two short percussive ticks (teeth closing)
        for (let i = 0; i < 2; i++) {
            const t = now + i * 0.08;
            const osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.setValueAtTime(200 + i * 80, t);
            osc.frequency.exponentialRampToValueAtTime(60, t + 0.04);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.12, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
            osc.connect(g);
            g.connect(ctx.destination);
            osc.start(t);
            osc.stop(t + 0.07);
        }
        // Soft squelch underneath
        const squelch = ctx.createOscillator();
        squelch.type = 'sine';
        squelch.frequency.setValueAtTime(120, now);
        squelch.frequency.exponentialRampToValueAtTime(40, now + 0.12);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0.08, now);
        sg.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        squelch.connect(sg);
        sg.connect(ctx.destination);
        squelch.start(now);
        squelch.stop(now + 0.15);
    }

    // Happy squeak: high-pitched delighted sound at 100% satiety
    playHappySqueak() {
        if (game._muted) return;
        const ctx = this._audioCtx();
        if (!ctx) return;
        const now = ctx.currentTime;
        // Rising chirp
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.06);
        osc.frequency.exponentialRampToValueAtTime(1600, now + 0.12);
        osc.frequency.exponentialRampToValueAtTime(2000, now + 0.15);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.2, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.26);
        // Second chirp (echo)
        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(800, now + 0.1);
        osc2.frequency.exponentialRampToValueAtTime(1400, now + 0.16);
        osc2.frequency.exponentialRampToValueAtTime(1800, now + 0.2);
        const g2 = ctx.createGain();
        g2.gain.setValueAtTime(0.1, now + 0.1);
        g2.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc2.connect(g2);
        g2.connect(ctx.destination);
        osc2.start(now + 0.1);
        osc2.stop(now + 0.31);
    }
}

window.addEventListener('load', () => {
    game.init();
});
