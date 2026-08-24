from anthropic import AnthropicVertex

# Use the correct Anthropic Vertex client with region="global"
client = AnthropicVertex(
    region="global", 
    project_id="project-f0647ed0-59f5-42e6-a98"
)

print("Connecting to Anthropic via Vertex AI...")

# Send the test prompt
message = client.messages.create(
    model="claude-fable-5", 
    max_tokens=1024,
    messages=[{
        "role": "user", 
        "content": "Hello! I am building founderOS. Act as my expert CTO. Give me 3 highly specific, non-obvious technical advantages I should build into this product."
    }],
)

print("\n--- AI RESPONSE ---")
print(message.content[0].text)
