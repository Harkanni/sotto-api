// Sotto api: every check that used to run in GitHub Actions' ci.yml, now on Jenkins (ADR on
// Jenkins in sotto-platform), plus the image build and demo deploy on main.
//
// AWS access comes from the jenkins user's AWS CLI profile (~jenkins/.aws, set with
// `sudo -u jenkins aws configure`); the ECR registry is worked out from the account.
//
// The Jenkins host needs Docker (with buildx), Node 24 with corepack, the AWS CLI, and the
// "Lockable Resources" plugin. Everything else (Python, ffmpeg, Postgres, Ollama…) runs in
// containers, so the host stays clean.
//
// Order: quick checks first (they fail fastest), then the image checks that boot the real
// services: smoke, a 30-minute recording through real transcription, and the eval set with a
// real embedding model.

/** Runs on every check stage's failure: the services' last lines, so the log says why. */
def serviceLogs() {
  sh '''
    for c in sotto-ci-api sotto-ci-worker sotto-ci-transcriber; do
      docker logs --tail 120 $c 2>&1 | sed "s/^/[$c] /" || true
    done
  '''
}

/**
 * Stops the app containers from the previous stage and gives the next one empty stores. The
 * Ollama model volume survives (a 275 MB download); Postgres and S3 start empty.
 */
def freshServices() {
  sh """
    docker rm -f sotto-ci-api sotto-ci-worker sotto-ci-transcriber >/dev/null 2>&1 || true
    docker compose -f compose.deps.yaml --profile ai down >/dev/null 2>&1 || true
    docker volume rm sotto-ci_pgdata sotto-ci_s3data >/dev/null 2>&1 || true
    docker compose -f compose.deps.yaml up -d --wait postgres redis rabbitmq s3 mailpit
    for i in \$(seq 1 60); do
      [ "\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8333/)" != "000" ] && break
      sleep 1
    done
    curl -s -X PUT -o /dev/null -w "bucket: %{http_code}\\n" http://localhost:8333/sotto-files
    curl -s -X PUT -o /dev/null http://localhost:8333/sotto-test
  """
}

pipeline {
  agent any

  options {
    timeout(time: 100, unit: 'MINUTES')
    // A newer push to the same branch or PR stops the older build: nobody needs its result.
    disableConcurrentBuilds(abortPrevious: true)
    // The api and web pipelines share the host's ports (5432, 4000, 8333…): one at a time.
    lock(resource: 'sotto-ci-host')
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  environment {
    AWS_REGION = 'eu-west-2'
    COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    // Compose names the network after the project: sotto-ci_default.
    COMPOSE_PROJECT_NAME = 'sotto-ci'
    NET = 'sotto-ci_default'
    DB = 'postgresql://sotto:sotto@postgres:5432/sotto'
    MQ = 'amqp://sotto:sotto@rabbitmq:5672'
    S3_ENV = '-e S3_ENDPOINT=http://s3:8333 -e S3_BUCKET=sotto-files -e S3_FORCE_PATH_STYLE=true -e S3_ACCESS_KEY_ID=ci -e S3_SECRET_ACCESS_KEY=ci'
    TEST_DATABASE_URL = 'postgresql://sotto:sotto@localhost:5432/postgres'
    TEST_S3_ENDPOINT = 'http://localhost:8333'
    S3_FORCE_PATH_STYLE = 'true'
    REQUIRE_INTEGRATION = '1'
    // Kept between builds (outside the workspace): the Whisper tiny model and pip/uv downloads.
    CACHE = "${env.JENKINS_HOME}/sotto-cache"
  }

  stages {
    stage('Secrets scan') {
      steps {
        sh 'docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:latest dir /repo --redact --verbose'
      }
    }

    stage('Start test databases') {
      steps { script { freshServices() } }
    }

    stage('Install') {
      steps { sh 'pnpm install --frozen-lockfile' }
    }

    stage('Build') {
      steps { sh 'pnpm build' }
    }

    stage('Lint and typecheck') {
      steps {
        sh 'pnpm lint'
        sh 'pnpm format:check'
        sh 'pnpm typecheck'
      }
    }

    stage('Test') {
      steps { sh 'pnpm test' }
    }

    stage('openapi.json is up to date') {
      steps {
        sh '''
          pnpm openapi
          git diff --exit-code openapi.json || {
            echo "openapi.json is stale. Run 'pnpm build && pnpm openapi' and commit it."; exit 1; }
        '''
      }
    }

    // The transcriber's own tests (ruff, pytest, the real Whisper test) in a Python container
    // with ffmpeg and espeak-ng. Files it writes are handed back to Jenkins' user.
    stage('Transcriber') {
      steps {
        sh '''
          mkdir -p "$CACHE/hf" "$CACHE/uv"
          docker run --rm -v "$PWD/services/transcriber:/src" -w /src \
            -v "$CACHE/hf:/root/.cache/huggingface" -v "$CACHE/uv:/root/.cache/uv" \
            -e RUN_WHISPER_TESTS=1 -e UV_PROJECT_ENVIRONMENT=/tmp/venv \
            -e HOST_IDS="$(id -u):$(id -g)" \
            ghcr.io/astral-sh/uv:python3.12-bookworm-slim sh -c '
              trap "chown -R $HOST_IDS /src" EXIT
              apt-get update -qq && apt-get install -y -qq ffmpeg espeak-ng >/dev/null
              uv sync --locked && uv run ruff check . && uv run ruff format --check . &&
              uv run pytest -q -p no:cacheprovider --junitxml=pytest.xml'
        '''
      }
      post { always { junit allowEmptyResults: true, testResults: 'services/transcriber/pytest.xml' } }
    }

    stage('Build images') {
      steps {
        sh '''
          docker build --build-arg APP=api -t sotto-api:ci .
          docker build --build-arg APP=worker -t sotto-worker:ci .
          docker build -t sotto-transcriber:ci services/transcriber
        '''
      }
    }

    // "One command starts everything": the real images on real Postgres, Redis, RabbitMQ and S3
    // answer /readyz, and their own HEALTHCHECKs agree.
    stage('Smoke') {
      steps {
        script { freshServices() }
        sh '''
          docker run --rm --network $NET -e DATABASE_URL=$DB sotto-api:ci sh scripts/migrate.sh
          docker run -d --name sotto-ci-api --network $NET -p 4000:4000 $S3_ENV \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 -e RABBITMQ_URL=$MQ \
            -e AUTH_SECRET="$(openssl rand -hex 32)" -e APP_URL=http://localhost:4000 sotto-api:ci
          docker run -d --name sotto-ci-worker --network $NET -p 4100:4100 -e RABBITMQ_URL=$MQ \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 -e AI_EMBEDDINGS=fake:fake-hash sotto-worker:ci
          docker run -d --name sotto-ci-transcriber --network $NET -p 5000:5000 -e RABBITMQ_URL=$MQ \
            -e TRANSCRIBER_ENGINE=fake sotto-transcriber:ci
          for i in $(seq 1 45); do
            if curl -fsS localhost:4000/readyz && curl -fsS localhost:4100/readyz && curl -fsS localhost:5000/readyz; then
              for c in sotto-ci-api sotto-ci-worker sotto-ci-transcriber; do
                for j in $(seq 1 20); do
                  [ "$(docker inspect -f '{{.State.Health.Status}}' $c)" = healthy ] && break; sleep 3
                done
                [ "$(docker inspect -f '{{.State.Health.Status}}' $c)" = healthy ] || { echo "$c not healthy"; exit 1; }
              done
              exit 0
            fi
            sleep 2
          done
          exit 1
        '''
      }
      post { failure { script { serviceLogs() } } }
    }

    // Phase 4's "done when": a PDF and a 30-minute recording (three sentences at known times)
    // go in like a browser sends them and reach Ready with the right pages and timestamps,
    // transcribed by faster-whisper (tiny, for speed).
    stage('Ingestion') {
      steps {
        script { freshServices() }
        sh '''
          mkdir -p "$CACHE/whisper" && chmod 777 "$CACHE/whisper"
          docker run --rm -v /tmp:/out debian:bookworm-slim sh -c '
            apt-get update -qq && apt-get install -y -qq ffmpeg espeak-ng >/dev/null
            espeak-ng -s 130 -w /tmp/s1.wav "Good morning everyone. This is the design review for the Lagos launch."
            espeak-ng -s 130 -w /tmp/s2.wav "Next item. The budget for the second quarter is approved."
            espeak-ng -s 130 -w /tmp/s3.wav "Last point. We ship the recorder on Friday."
            ffmpeg -loglevel error -y -f lavfi -t 1800 -i anullsrc=r=16000:cl=mono \
              -i /tmp/s1.wav -i /tmp/s2.wav -i /tmp/s3.wav -filter_complex \
              "[1]aresample=16000,adelay=3000[a];[2]aresample=16000,adelay=1230000[b];[3]aresample=16000,adelay=1770000[c];[0][a][b][c]amix=inputs=4:duration=first:normalize=0" \
              -ac 1 -c:a libopus -b:a 32k /out/sotto-ci-meeting.ogg
            chmod 644 /out/sotto-ci-meeting.ogg'
          docker run --rm --network $NET -e DATABASE_URL=$DB sotto-api:ci sh scripts/migrate.sh
          docker run -d --name sotto-ci-api --network $NET -p 4000:4000 $S3_ENV \
            -e S3_PUBLIC_ENDPOINT=http://localhost:8333 -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 \
            -e RABBITMQ_URL=$MQ -e AUTH_SECRET="$(openssl rand -hex 32)" -e APP_URL=http://localhost:4000 \
            -e SMTP_URL=smtp://mailpit:1025 -e AUTH_RATE_LIMIT=off sotto-api:ci
          docker run -d --name sotto-ci-worker --network $NET -p 4100:4100 $S3_ENV -e RABBITMQ_URL=$MQ \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 -e AI_EMBEDDINGS=fake:fake-hash sotto-worker:ci
          docker run -d --name sotto-ci-transcriber --network $NET -p 5000:5000 $S3_ENV -e RABBITMQ_URL=$MQ \
            -e TRANSCRIBER_ENGINE=faster-whisper -e WHISPER_MODEL=tiny -v "$CACHE/whisper:/models" \
            sotto-transcriber:ci
          for i in $(seq 1 90); do
            curl -fsS localhost:4000/readyz >/dev/null && curl -fsS localhost:4100/readyz >/dev/null \
              && curl -fsS localhost:5000/readyz >/dev/null && break
            sleep 2
          done
          API_URL=http://localhost:4000 MAILPIT_URL=http://localhost:8025 \
            MEETING_FILE=/tmp/sotto-ci-meeting.ogg node scripts/ingestion-check.ts
        '''
      }
      post { failure { script { serviceLogs() } } }
    }

    // Phase 5's eval set with a real embedding model (Ollama, nomic-embed-text): the sample
    // content is indexed, every question searched and asked by an owner and a restricted viewer,
    // and evals/score.ts decides. The model is kept in a named volume between builds.
    stage('Evals') {
      steps {
        script { freshServices() }
        sh '''
          docker compose -f compose.deps.yaml --profile ai up -d ollama
          for i in $(seq 1 60); do curl -fsS localhost:11434/api/version >/dev/null && break; sleep 1; done
          curl -fsS localhost:11434/api/pull -d '{"model":"nomic-embed-text"}' | tail -1
          curl -fsS localhost:11434/api/embed -d '{"model":"nomic-embed-text","input":"ready"}' | head -c 80; echo
          AI="-e AI_EMBEDDINGS=ollama:nomic-embed-text -e OLLAMA_URL=http://ollama:11434"
          docker run --rm --network $NET -e DATABASE_URL=$DB sotto-api:ci sh scripts/migrate.sh
          docker run -d --name sotto-ci-api --network $NET -p 4000:4000 $S3_ENV $AI \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 -e RABBITMQ_URL=$MQ \
            -e AUTH_SECRET="$(openssl rand -hex 32)" -e APP_URL=http://localhost:4000 \
            -e SMTP_URL=smtp://mailpit:1025 -e AUTH_RATE_LIMIT=off -e ASK_RATE_PER_MINUTE=1000 sotto-api:ci
          docker run -d --name sotto-ci-worker --network $NET -p 4100:4100 $S3_ENV $AI -e RABBITMQ_URL=$MQ \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 sotto-worker:ci
          for i in $(seq 1 90); do
            curl -fsS localhost:4000/readyz >/dev/null && curl -fsS localhost:4100/readyz >/dev/null && break
            sleep 2
          done
          API_URL=http://localhost:4000 MAILPIT_URL=http://localhost:8025 node scripts/eval.ts
          OLLAMA_URL=http://localhost:11434 node scripts/eval-similarity.ts || true
        '''
      }
      post { failure { script { serviceLogs() } } }
    }

    stage('Build and push images') {
      when { branch 'main' }
      steps {
        script { env.TAG = "sha-${env.GIT_COMMIT.take(7)}" }
        sh '''
          ECR_REGISTRY="${ECR_REGISTRY:-$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$AWS_REGION.amazonaws.com}"
          aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_REGISTRY

          docker buildx build --platform linux/arm64 --build-arg APP=api \
            --build-arg APP_VERSION=$TAG --build-arg GIT_SHA=$GIT_COMMIT \
            -t $ECR_REGISTRY/sotto/api:$TAG -t $ECR_REGISTRY/sotto/api:main --push .

          docker buildx build --platform linux/arm64 --build-arg APP=worker \
            --build-arg APP_VERSION=$TAG --build-arg GIT_SHA=$GIT_COMMIT \
            -t $ECR_REGISTRY/sotto/worker:$TAG -t $ECR_REGISTRY/sotto/worker:main --push .

          docker buildx build --platform linux/arm64 \
            --build-arg APP_VERSION=$TAG --build-arg GIT_SHA=$GIT_COMMIT \
            -t $ECR_REGISTRY/sotto/transcriber:$TAG -t $ECR_REGISTRY/sotto/transcriber:main \
            --push services/transcriber
        '''
      }
    }

    stage('Deploy to demo') {
      when { branch 'main' }
      steps {
        sh '''
          ID=$(aws ssm send-command --document-name sotto-deploy \
            --targets "Key=tag:sotto-role,Values=demo" \
            --parameters "services=api worker transcriber,tag=$TAG" \
            --query Command.CommandId --output text)
          echo "Deploy command: $ID"
          for i in $(seq 1 60); do
            STATUS=$(aws ssm list-commands --command-id $ID --query 'Commands[0].Status' --output text)
            echo "status: $STATUS"
            [ "$STATUS" = "Success" ] && exit 0
            case "$STATUS" in Failed|Cancelled|TimedOut) exit 1 ;; esac
            sleep 10
          done
          exit 1
        '''
      }
    }
  }

  post {
    always {
      sh '''
        docker rm -f sotto-ci-api sotto-ci-worker sotto-ci-transcriber >/dev/null 2>&1 || true
        # The Ollama model volume is kept (it's a 275 MB download); everything else goes.
        docker compose -f compose.deps.yaml --profile ai down >/dev/null 2>&1 || true
        docker volume rm sotto-ci_pgdata sotto-ci_s3data >/dev/null 2>&1 || true
        rm -f /tmp/sotto-ci-meeting.ogg
      '''
      cleanWs()
    }
  }
}
