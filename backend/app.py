from flask import Flask, send_from_directory, request, jsonify
from flask_cors import CORS
import json
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
            'created_at': self.created_at
        }
    
    def feed(self):
        """Кормление питомца"""
        self.hunger = max(0, self.hunger - 30)
        self.mood = min(100, self.mood + 5)
        self.energy = max(0, self.energy - 5)
        self.update_timestamp()
        return {'action': 'feed', 'hunger': self.hunger}
    
    def pet(self):
        """Поглаживание питомца"""
        self.mood = min(100, self.mood + 15)
        self.energy = max(0, self.energy - 3)
        self.health = min(100, self.health + 2)
        self.update_timestamp()
        return {'action': 'pet', 'mood': self.mood}
    
    def wash(self):
        """Мытьё питомца"""
        self.cleanliness = min(100, self.cleanliness + 40)
        self.hunger = min(100, self.hunger + 10)
        self.energy = max(0, self.energy - 15)
        self.update_timestamp()
        return {'action': 'wash', 'cleanliness': self.cleanliness}
    
    def sleep(self):
        """Сон питомца"""
        self.energy = min(100, self.energy + 50)
        self.hunger = min(100, self.hunger + 15)
        self.health = min(100, self.health + 5)
        self.update_timestamp()
        return {'action': 'sleep', 'energy': self.energy}
    
    def view_drawing(self, happiness_boost=10):
        """Питомец смотрит рисунок - повышает настроение"""
        self.mood = min(100, self.mood + happiness_boost)
        self.update_timestamp()
        return {'action': 'view_drawing', 'mood': self.mood}
    
    def update_timestamp(self):
        """Обновить время последнего обновления"""
        self.last_update = datetime.now().isoformat()
    
    def decay_stats(self):
        """Показатели уменьшаются со временем"""
        self.hunger = min(100, self.hunger + 1)  # голод растёт
        self.cleanliness = max(0, self.cleanliness - 1)  # грязь растёт
        self.energy = max(0, self.energy - 0.5)  # энергия падает
        self.mood = max(0, self.mood - 0.5)  # настроение падает
        
        # Здоровье зависит от других показателей
        if self.hunger > 80 or self.cleanliness < 20:
            self.health = max(0, self.health - 2)
        
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
    
    return jsonify(pet.to_dict())


@app.route('/api/pet/<pet_id>/feed', methods=['POST'])
def feed_pet(pet_id):
    """Накормить питомца"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    result = pet.feed()
    
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


@app.route('/api/pet/<pet_id>/wash', methods=['POST'])
def wash_pet(pet_id):
    """Помыть питомца"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    result = pet.wash()
    
    return jsonify({
        'action': result['action'],
        'pet': pet.to_dict()
    })


@app.route('/api/pet/<pet_id>/sleep', methods=['POST'])
def sleep_pet(pet_id):
    """Уложить питомца спать"""
    if pet_id not in pets_data:
        return jsonify({'error': 'Pet not found'}), 404
    
    pet = pets_data[pet_id]
    result = pet.sleep()
    
    return jsonify({
        'action': result['action'],
        'pet': pet.to_dict()
    })


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
        return jsonify({'error': 'Pet not found'}), 404
    
    sketches = user_sketches[pet_id]
    return jsonify({
        'sketches': sketches,
        'count': len(sketches)
    })


@app.route('/api/sketches/<pet_id>/save', methods=['POST'])
def save_sketch(pet_id):
    """Сохранить новый рисунок"""
    if pet_id not in user_sketches:
        return jsonify({'error': 'Pet not found'}), 404
    
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
    app.run(debug=True, port=5000)
