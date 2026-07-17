FROM node:22-bookworm-slim

# Install system dependencies for native Canvas and Python packages
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    build-essential \
    g++ \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Pre-install Node packages
RUN npm install -g canvas jimp sharp axios zod

# Pre-install Python packages in virtual env
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir Pillow requests pandas numpy matplotlib

# Add AWS CLI (or compatible tool) for S3 syncing
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && apt-get update && apt-get install -y unzip \
    && unzip awscliv2.zip && ./aws/install \
    && rm -rf awscliv2.zip aws /var/lib/apt/lists/*

COPY bootstrap.sh /opt/bootstrap.sh
RUN chmod +x /opt/bootstrap.sh

ENTRYPOINT ["/opt/bootstrap.sh"]
