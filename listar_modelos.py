import os
from dotenv import load_dotenv
from google import genai

# Carrega a sua GEMINI_API_KEY do arquivo .env
load_dotenv()

print("Buscando modelos disponíveis para a sua chave...\n")
client = genai.Client()

try:
    # Lista todos os modelos disponíveis
    for model in client.models.list():
        # Filtra para mostrar apenas as opções de texto do Gemini
        if "gemini" in model.name and "vision" not in model.name:
            print(model.name)
except Exception as e:
    print(f"Erro ao buscar modelos: {e}")