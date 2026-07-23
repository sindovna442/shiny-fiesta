from persistence import save_state, load_state

from flask import Flask, send_from_directory, request, jsonify
from flask_cors import CORS
from datetime import datetime, timedelta
import uuid
import os

app = Flask(__name__, static_folder='../frontend', static_url_path='')
CORS(app)

# In-memory storage (in production, use a database)
pets_data = {}
user_sketches = {}

# Pet Constants
PET_STATES = {
    'BABY': 0,
    'TEEN': 1,
    'ADULT': 2,
    'ELDER': 3
}

class DemonCat:
    """Класс для демон-кота тамагочи"""
    def __init__(self, pet_id, name="Demonic"):
        self.pet_id = pet_id
        self.name = name
        self.hunger = 50  # 0-100
        self.cleanliness = 50  # 0-100
        self.mood = 70  # 0-100
        self.energy = 80  # 0-100
        self.health = 90  # 0-100
        self.stage = PET_STATES['BABY']  # эволюция питомца
        self.total_care_time = 0  # часы заботы
        self.last_update = datetime.now().isoformat()
        self.created_at = datetime.now().isoformat()
        
        # Состояния взаимодействия с предметами
        self.in_bath = False      # в ванне?
        self.in_bed = False       # в кровати?
        self.is_eating = False    # ест?
        self.food_held_time = None  # когда взял еду
        
    def to_dict(self):
        return {
            'pet_id': self.pet_id,
            'name': self.name,
            'hunger': self.hunger,
            'cleanliness': self.cleanliness,
            'mood': self.mood,
            'energy': self.energy,
            'health': self.health,
            'stage': self.stage,
            'total_care_time': self.total_care_time,
            'last_update': self.last_update,
            'created_at': self.created_at,
            'in_bath': self.in_bath,
            'in_bed': self.in_bed,
            'is_eating': self.is_eating
        }
    
    def feed(self):
        """Кормление — ждём пока кот съест (фронт запускает eat_food через 2с)"""
        self.is_eating = True
        self.food_held_time = datetime.now().isoformat()
        self.update_timestamp()
        return {'action': 'feed_start', 'is_eating': True}
    
    def eat_food(self):
        """Съесть еду — голод падает, настроение растёт"""
        self.hunger = max(0, self.hunger - 25)
        self.mood = min(100, self.mood + 8)
        self.energy = max(0, self.energy - 3)
        self.is_eating = False
        self.food_held_time = None
        self.update_timestamp()
        return {'action': 'eat', 'hunger': self.hunger}
    
    def pet(self):
        """Поглаживание — только настроение + здоровье, без влияния на голод"""
        self.mood = min(100, self.mood + 12)
        self.health = min(100, self.health + 1)
        self.energy = max(0, self.energy - 2)
        self.update_timestamp()
        return {'action': 'pet', 'mood': self.mood}
    
    def enter_bath(self):
        """Войти в ванну — чистота начнёт восстанавливаться"""
        if self.in_bath:
            return self.exit_bath()
        self.in_bath = True
        self.update_timestamp()
        return {'action': 'enter_bath', 'in_bath': True}
    
    def exit_bath(self):
        """Выйти из ванны"""
        self.in_bath = False
        self.cleanliness = min(100, self.cleanliness + 30)  # бонус при выходе
        self.energy = max(0, self.energy - 5)
        self.update_timestamp()
        return {'action': 'exit_bath', 'cleanliness': self.cleanliness}
    
    def enter_bed(self):
        """Лечь в кровать — энергия начнёт восстанавливаться"""
        if self.in_bed:
            return self.exit_bed()
        self.in_bed = True
        self.update_timestamp()
        return {'action': 'enter_bed', 'in_bed': True}
    
    def exit_bed(self):
        """Встать с кровати"""
        self.in_bed = False
        self.energy = min(100, self.energy + 20)  # бонус при выходе
        self.hunger = min(100, self.hunger + 8)
        self.mood = min(100, self.mood + 5)
        self.update_timestamp()
        return {'action': 'exit_bed', 'energy': self.energy}
    
    def wash_instantly(self):
        """Быстрое мытьё (если не через ванну) — уже не нужно, ванна заменяет"""
        return self.enter_bath()
    
    def sleep(self):
        """Старый метод — перенаправляем на enter_bed"""
        return self.enter_bed()
    
    def view_drawing(self, happiness_boost=10):
        """Питомец смотрит рисунок - повышает настроение"""
        self.mood = min(100, self.mood + happiness_boost)
        self.update_timestamp()
        return {'action': 'view_drawing', 'mood': self.mood}
    
    def update_timestamp(self):
        """Обновить время последнего обновления"""
        self.last_update = datetime.now().isoformat()
    
    def process_continuous_effects(self):
        """Обработка непрерывных эффектов от предметов"""
        now = datetime.now()
        
        # В ванне — чистота растёт, энергия медленно падает
        if self.in_bath:
            self.cleanliness = min(100, self.cleanliness + 2)
            self.energy = max(0, self.energy - 1)
            self.mood = min(100, self.mood + 0.5)
        
        # В кровати — энергия растёт
        if self.in_bed:
            self.energy = min(100, self.energy + 3)
            self.health = min(100, self.health + 0.5)
    
    def decay_stats(self):
        """Показатели медленно меняются со временем"""
        if self.in_bath or self.in_bed:
            # В ванне/кровати статы не падают
            self.process_continuous_effects()
            self.update_timestamp()
            return
        
        if self.is_eating:
            # Пока ест — голод не растёт
            self.process_continuous_effects()
            self.update_timestamp()
            return
        
        # Медленное убывание
        self.hunger = min(100, self.hunger + 0.3)  # голод растёт медленно
        self.cleanliness = max(0, self.cleanliness - 0.2)  # грязь растёт медленно
        self.energy = max(0, self.energy - 0.2)  # энергия падает медленно
        self.mood = max(0, self.mood - 0.15)  # настроение падает медленно
        
        # Здоровье зависит от других показателей
        if self.hunger > 85 or self.cleanliness < 15:
            self.health = max(0, self.health - 0.5)
        elif self.hunger < 40 and self.cleanliness > 60 and self.mood > 60:
            self.health = min(100, self.health + 0.3)
        
        self.process_continuous_effects()
        self.update_timestamp()
    
    def check_evolution(self):
        """Проверить эволюцию питомца"""
        hours = self.total_care_time
        if hours >= 72 and self.stage == PET_STATES['BABY']:
            self.stage = PET_STATES['TEEN']
            return 'TEEN'
        elif hours >= 168 and self.stage == PET_STATES['TEEN']:
            self.stage = PET_STATES['ADULT']
            return 'ADULT'
        elif hours >= 336 and self.stage == PET_STATES['ADULT']:
            self.stage = PET_STATES['ELDER']
            return 'ELDER'
        return None


# Rehydrate pets + sketches from disk (must come AFTER DemonCat class definition)
load_state(pets_data, user_sketches, DemonCat)


# ============ ROUTES ============

@app.route('/')
def index():
    """Главная страница"""
    return send_from_directory('../frontend', 'index.html')


@app.route('/<path:path>')
def send_static(path):
    """Отправить статические файлы (CSS, JS)"""
    return send_from_directory('../frontend', path)


@app.route('/api/pet/create', methods=['POST'])
def create_pet():
    """Создать нового питомца"""
    data = request.json
    pet_name = data.get('name', 'Demonic')
    pet_id = str(uuid.uuid4())
    
    pet = DemonCat(pet_id, pet_name)
    pets_data[pet_id] = pet
    user_sketches[pet_id] = []
    
    return jsonify({
        'success': True,
        'pet_id': pet_id,
        'pet': pet.to_dict()
    }), 201


@app.route('/api/pet/<pet_id>', methods=['GET'])
def get_pet(pet_id):
    """Получить статус питомца"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    pet.decay_stats()  # Обновить показатели
    
    save_state(pets_data, user_sketches)
    return jsonify(pet.to_dict())


@app.route('/api/pet/<pet_id>/feed', methods=['POST'])
def feed_pet(pet_id):
    """Начать кормление — кот берёт еду"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    result = pet.feed()
    
    return jsonify({
        'action': result['action'],
        'pet': pet.to_dict()
    })


@app.route('/api/pet/<pet_id>/eat', methods=['POST'])
def eat_food(pet_id):
    """Съесть еду (вызывается через 2с после feed)"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    result = pet.eat_food()
    
    return jsonify({
        'action': result['action'],
        'pet': pet.to_dict()
    })


@app.route('/api/pet/<pet_id>/pet', methods=['POST'])
def pet_pet(pet_id):
    """Погладить питомца"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    result = pet.pet()
    
    return jsonify({
        'action': result['action'],
        'pet': pet.to_dict()
    })


@app.route('/api/pet/<pet_id>/bath-toggle', methods=['POST'])
def bath_toggle(pet_id):
    """Войти/выйти из ванны"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    
    if pet.in_bath:
        result = pet.exit_bath()
    else:
        result = pet.enter_bath()
    
    return jsonify({
        'action': result['action'],
        'pet': pet.to_dict()
    })


@app.route('/api/pet/<pet_id>/bed-toggle', methods=['POST'])
def bed_toggle(pet_id):
    """Лечь/встать с кровати"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    
    if pet.in_bed:
        result = pet.exit_bed()
    else:
        result = pet.enter_bed()
    
    return jsonify({
        'action': result['action'],
        'pet': pet.to_dict()
    })


@app.route('/api/pet/<pet_id>/wash', methods=['POST'])
def wash_pet(pet_id):
    """Старый метод — мытьё (перенаправляем на bath-toggle)"""
    return bath_toggle(pet_id)


@app.route('/api/pet/<pet_id>/sleep', methods=['POST'])
def sleep_pet(pet_id):
    """Старый метод — сон (перенаправляем на bed-toggle)"""
    return bed_toggle(pet_id)


@app.route('/api/pet/<pet_id>/view-drawing', methods=['POST'])
def view_drawing(pet_id):
    """Показать рисунок питомцу"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    data = request.json
    happiness_boost = data.get('boost', 10)
    result = pet.view_drawing(happiness_boost)
    
    return jsonify({
        'action': result['action'],
        'pet': pet.to_dict()
    })


# ============ SKETCH ROUTES ============

@app.route('/api/sketches/<pet_id>', methods=['GET'])
def get_sketches(pet_id):
    """Получить все рисунки питомца"""
    if pet_id not in user_sketches:
        return jsonify({'sketches': [], 'count': 0})
    
    sketches = user_sketches[pet_id]
    return jsonify({
        'sketches': sketches,
        'count': len(sketches)
    })


@app.route('/api/sketches/<pet_id>/save', methods=['POST'])
def save_sketch(pet_id):
    """Сохранить новый рисунок"""
    if pet_id not in user_sketches:
        user_sketches[pet_id] = []
    
    data = request.json
    sketch_data = data.get('imageData')
    title = data.get('title', 'Untitled')
    
    if not sketch_data:
        return jsonify({'error': 'No image data provided'}), 400
    
    sketch = {
        'id': str(uuid.uuid4()),
        'title': title,
        'imageData': sketch_data,
        'created_at': datetime.now().isoformat()
    }
    
    user_sketches[pet_id].append(sketch)
    
    # Показать рисунок питомцу - повышает настроение
    if pet_id in pets_data:
        pets_data[pet_id].view_drawing()
    
    return jsonify({
        'success': True,
        'sketch': sketch
    }), 201


@app.route('/api/sketches/<pet_id>/<sketch_id>', methods=['GET'])
def get_sketch(pet_id, sketch_id):
    """Получить конкретный рисунок"""
    if pet_id not in user_sketches:
        return jsonify({'error': 'Pet not found'}), 404
    
    for sketch in user_sketches[pet_id]:
        if sketch['id'] == sketch_id:
            return jsonify(sketch)
    
    return jsonify({'error': 'Sketch not found'}), 404


@app.route('/api/sketches/<pet_id>/<sketch_id>', methods=['DELETE'])
def delete_sketch(pet_id, sketch_id):
    """Удалить рисунок"""
    if pet_id not in user_sketches:
        return jsonify({'error': 'Pet not found'}), 404
    
    user_sketches[pet_id] = [
        s for s in user_sketches[pet_id] if s['id'] != sketch_id
    ]
    
    return jsonify({'success': True})


if __name__ == '__main__':
    host = os.environ.get('HOST', '0.0.0.0')
    try:
        port = int(os.environ.get('PORT', 5000))
    except ValueError:
        port = 5000
    debug = os.environ.get('FLASK_DEBUG', '1') == '1'
    app.run(host=host, port=port, debug=debug)
