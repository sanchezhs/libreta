import pytest
from fastapi.testclient import TestClient

from app import main
from app.db import connect


@pytest.fixture
def conn():
    c = connect(":memory:")
    main.set_conn(c)
    yield c
    c.close()


@pytest.fixture
def client(conn):
    return TestClient(main.app)
