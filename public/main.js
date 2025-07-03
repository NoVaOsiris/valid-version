// main.js

// Функция для обработки логина на index.html
if (document.getElementById('loginForm')) {
    document.getElementById('loginForm').onsubmit = e => {
        e.preventDefault();
        const name = document.getElementById('name').value.trim();
        const password = document.getElementById('password').value.trim();
        fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, password })
        })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    document.getElementById('error').innerText = data.error;
                } else {
                    localStorage.setItem('seller', JSON.stringify(data));
                    if (data.role === 'admin') {
                        window.location.href = 'admin.html';
                    } else {
                        window.location.href = 'seller.html';
                    }
                }
            })
            .catch(() => {
                document.getElementById('error').innerText = 'Ошибка подключения к серверу';
            });
    };
}
