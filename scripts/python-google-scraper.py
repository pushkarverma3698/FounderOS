import requests
import time
import random
from bs4 import BeautifulSoup
import sys
import csv

def scrape_google(query):
    url = f"https://www.google.com/search?q={requests.utils.quote(query)}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
    }
    response = requests.get(url, headers=headers)
    if response.status_code == 429:
        return "RATE_LIMIT"
    
    soup = BeautifulSoup(response.text, 'html.parser')
    results = soup.find_all('div', class_='g')
    
    found = 0
    for g in results:
        a_tag = g.find('a')
        if a_tag and 'href' in a_tag.attrs:
            href = a_tag['href']
            if 'linkedin.com/in' in href:
                found += 1
    return found

def main():
    companies = []
    with open('docs/strategy/data/ind-sponsors-work.csv', 'r') as f:
        reader = csv.reader(f)
        next(reader) # skip date
        next(reader) # skip header
        for row in reader:
            if row:
                companies.append(row[0])
                if len(companies) >= 20:
                    break

    successes = 0
    rate_limits = 0
    total = len(companies)
    
    print("Starting 20-company benchmark...")
    
    start_time = time.time()
    
    for c in companies:
        query = f'site:linkedin.com/in "Hiring Manager" OR "Recruiter" "{c}" "Netherlands"'
        res = scrape_google(query)
        if res == "RATE_LIMIT":
            rate_limits += 1
            print(f"[RATE LIMIT] {c}")
        elif res > 0:
            successes += 1
            print(f"[SUCCESS] {c} -> {res} profiles")
        else:
            print(f"[MISS] {c}")
            
        time.sleep(random.uniform(2, 5))
        
    end_time = time.time()
    
    print("\n=== RESULTS ===")
    print(f"Total Attempted: {total}")
    print(f"Successes: {successes}")
    print(f"Rate Limits: {rate_limits}")
    print(f"Time Taken: {end_time - start_time:.2f}s")
    
if __name__ == "__main__":
    main()
