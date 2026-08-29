import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.licence import generate_signing_key  # noqa: E402
from app.store import Store  # noqa: E402


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "test.db"))
    yield s
    s.close()


@pytest.fixture(scope="session")
def signing_key():
    # One key for the whole session: P-256 generation is cheap but scrypt in the same tests is not,
    # and there is nothing per-test about a key.
    return generate_signing_key()
