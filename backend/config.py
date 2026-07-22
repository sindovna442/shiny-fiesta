# Конфигурация приложения
import os

class Config:
    """Базовая конфигурация"""
    DEBUG = True
    TESTING = False
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-key')

class DevelopmentConfig(Config):
    """Конфигурация для разработки"""
    DEBUG = True
    CORS_HEADERS = 'Content-Type'

class ProductionConfig(Config):
    """Конфигурация для продакшена"""
    DEBUG = False

class TestingConfig(Config):
    """Конфигурация для тестирования"""
    TESTING = True
