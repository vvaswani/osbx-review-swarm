import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient
from main import create_app
from dependencies import get_db, database_url
from models import Base

@pytest.fixture(scope="session")
def test_engine():
    """Create test database engine"""
    test_engine = create_engine(database_url)
    Base.metadata.create_all(bind=test_engine)
    yield test_engine
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(scope="function")
def test_db(test_engine):
    """Create test database session that rolls back after each test"""
    connection = test_engine.connect()
    transaction = connection.begin()
    db = sessionmaker(
        autocommit=False, autoflush=False, bind=connection,
        join_transaction_mode="create_savepoint"
    )()
    try:
        yield db
    finally:
        db.close()
        transaction.rollback()
        connection.close()


@pytest.fixture
def test_app(test_engine):
    """Create test FastAPI application with test database"""

    def override_get_db():
        TestingSessionLocal = sessionmaker(
            autocommit=False, autoflush=False, bind=test_engine
        )
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app = create_app()
    app.dependency_overrides[get_db] = override_get_db
    return app


@pytest.fixture
def client(test_app):
    """Create test client"""
    return TestClient(test_app)
