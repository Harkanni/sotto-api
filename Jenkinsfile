// Sotto api: every check that used to run in GitHub Actions' ci.yml, now on Jenkins (ADR on
// Jenkins in sotto-platform), plus the image build and demo deploy on main.
//
// AWS access comes from the jenkins user's AWS CLI profile (~jenkins/.aws, set with
// `sudo -u jenkins aws configure`); the ECR registry is worked out from the account.
//
// The Jenkins host needs Docker, Node 24 with corepack and the AWS CLI. Builds run side by side,
// each in its own slot (useSlot below). Everything else (Python, ffmpeg, Postgres, Ollama…) runs in
// containers, so the host stays clean.
//
// Order: the code checks, transcriber tests and image builds side by side, then the image
// checks that boot the real services: smoke, a 30-minute recording through real
// transcription, and the eval set with a real embedding model.

/** A host port moved into slot n. */
def slotPort(int base, int n) {
  return "${base + 20 * n}"
}

/**
 * Gives this build its own slot on the host, so several builds (api and web, or two branches)
 * run at once without colliding: Jenkins' executor number picks the slot, every host port moves
 * by 20 per slot (slot 0 keeps the usual ones), and container, network, volume and image names
 * carry it. Keep the node at 5 executors or fewer, or ports start to overlap.
 */
def useSlot() {
  def n = (env.EXECUTOR_NUMBER ?: '0') as int
  env.CI_NAME = "sotto-ci-${n}"
  env.COMPOSE_PROJECT_NAME = env.CI_NAME
  env.NET = "${env.CI_NAME}_default"
  env.IMG = "ci-${n}"
  env.PG_PORT = slotPort(5432, n); env.REDIS_PORT = slotPort(6379, n); env.AMQP_PORT = slotPort(5672, n)
  env.MQ_UI_PORT = slotPort(15672, n); env.S3_PORT = slotPort(8333, n); env.SMTP_PORT = slotPort(1025, n)
  env.MAILPIT_PORT = slotPort(8025, n); env.OLLAMA_PORT = slotPort(11434, n)
  env.API_PORT = slotPort(4000, n); env.WORKER_PORT = slotPort(4100, n); env.TRANS_PORT = slotPort(5000, n)
  env.TEST_DATABASE_URL = "postgresql://sotto:sotto@localhost:${env.PG_PORT}/postgres"
  env.TEST_S3_ENDPOINT = "http://localhost:${env.S3_PORT}"
  // The tests' own defaults point at the usual ports: aim them at this slot's services.
  env.REDIS_URL = "redis://localhost:${env.REDIS_PORT}"
  env.RABBITMQ_URL = "amqp://sotto:sotto@localhost:${env.AMQP_PORT}"
  echo "Slot ${n}: ${env.CI_NAME}, Postgres on ${env.PG_PORT}, api on ${env.API_PORT}"
}

/** Runs on every check stage's failure: the services' last lines, so the log says why. */
def serviceLogs() {
  sh '''
    for c in $CI_NAME-api $CI_NAME-worker $CI_NAME-transcriber; do
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
    docker rm -f \$CI_NAME-api \$CI_NAME-worker \$CI_NAME-transcriber >/dev/null 2>&1 || true
    docker compose -f compose.deps.yaml --profile ai down >/dev/null 2>&1 || true
    docker volume rm \${CI_NAME}_pgdata \${CI_NAME}_s3data >/dev/null 2>&1 || true
    docker compose -f compose.deps.yaml up -d --wait postgres redis rabbitmq s3 mailpit
    for i in \$(seq 1 60); do
      [ "\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:\$S3_PORT/)" != "000" ] && break
      sleep 1
    done
    curl -s -X PUT -o /dev/null -w "bucket: %{http_code}\\n" http://localhost:\$S3_PORT/sotto-files
    curl -s -X PUT -o /dev/null http://localhost:\$S3_PORT/sotto-test
  """
}

/**
 * Whether there's a demo to deploy to. `terraform destroy` removes everything, the image
 * repositories included, so while it's down main skips the push and the deploy (they don't
 * fail); after `terraform apply`, Build main once and both run.
 */
def demoIsUp() {
  if (env.DEMO_UP == null) {
    // 0: up. 3: down. Anything else (say, missing AWS permissions) fails the build rather than
    // quietly skipping the deploy.
    def rc = sh(returnStatus: true, script: '''
      out=$(aws ecr describe-repositories --repository-names sotto/api 2>&1) || {
        echo "$out" | grep -q RepositoryNotFoundException && exit 3; echo "$out"; exit 1; }
      n=$(aws ec2 describe-instances --filters Name=tag:sotto-role,Values=demo \
        Name=instance-state-name,Values=running --query 'length(Reservations)' --output text) || exit 1
      [ "$n" != 0 ] || exit 3
    ''')
    if (rc != 0 && rc != 3) { error("Couldn't check the demo with AWS (exit ${rc}); see above.") }
    env.DEMO_UP = rc == 0 ? 'true' : 'false'
    if (rc == 3) {
      echo 'The demo is down (no ECR repository or running demo server): skipping push and deploy.'
    }
  }
  return env.DEMO_UP == 'true'
}

pipeline {
  agent any

  options {
    timeout(time: 100, unit: 'MINUTES')
    // A newer push to the same branch or PR stops the older build: nobody needs its result.
    disableConcurrentBuilds(abortPrevious: true)
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  environment {
    AWS_REGION = 'eu-west-2'
    COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    DB = 'postgresql://sotto:sotto@postgres:5432/sotto'
    MQ = 'amqp://sotto:sotto@rabbitmq:5672'
    S3_ENV = '-e S3_ENDPOINT=http://s3:8333 -e S3_BUCKET=sotto-files -e S3_FORCE_PATH_STYLE=true -e S3_ACCESS_KEY_ID=ci -e S3_SECRET_ACCESS_KEY=ci'
    S3_FORCE_PATH_STYLE = 'true'
    REQUIRE_INTEGRATION = '1'
    // Kept between builds (outside the workspace): the Whisper tiny model and pip/uv downloads.
    CACHE = "${env.JENKINS_HOME}/sotto-cache"
  }

  stages {
    stage('Slot') {
      steps { script { useSlot() } }
    }

    // Everything that doesn't need the built images runs side by side: the secrets scan, the
    // code checks, the transcriber's tests and the image builds. On a many-core host this is
    // most of the time saved.
    stage('Checks and images') {
      parallel {
        stage('Secrets scan') {
          steps {
            // Pinned: with `latest`, a new release could change the rules (or break the scan)
            // without a commit here. v8.30.1 is what `latest` was on 2026-10-15. Bump on purpose.
            sh 'docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 dir /repo --redact --verbose'
          }
        }

        stage('Code') {
          stages {
            stage('Install and build') {
              steps {
                script { freshServices() }
                sh 'pnpm install --frozen-lockfile'
                sh 'pnpm build'
              }
            }
            // Lint, format, typecheck, unit + integration tests and the openapi drift check at
            // once; each prints its own block, and any failure fails the stage.
            stage('Lint, typecheck, test, openapi') {
              steps {
                sh '''
                  mkdir -p .ci
                  # set +e inside: Jenkins' shell stops at the first error, which would skip writing the code.
                  run() { name=$1; shift; ( set +e; "$@" > ".ci/$name.log" 2>&1; echo $? > ".ci/$name.rc" ) & }
                  run lint pnpm lint
                  run format pnpm format:check
                  # tsc directly: the package scripts run `prisma generate` first, which would
                  # rewrite the client while the tests are loading it. Build already generated it.
                  run typecheck pnpm --filter './apps/**' --filter './packages/**' -r exec tsc -p tsconfig.json --noEmit
                  run test pnpm test
                  run openapi sh -c 'pnpm openapi && git diff --exit-code openapi.json || {
                    echo "openapi.json is stale. Run pnpm build && pnpm openapi and commit it."; exit 1; }'
                  wait
                  failed=""
                  for n in lint format typecheck test openapi; do
                    echo "===== $n (exit $(cat .ci/$n.rc))"; cat ".ci/$n.log"
                    [ "$(cat .ci/$n.rc)" = 0 ] || failed="$failed $n"
                  done
                  [ -z "$failed" ] || { echo "Failed:$failed"; exit 1; }
                '''
              }
            }
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

        // Built once, with the release's version baked in: the Jenkins host is arm64 like the
        // demo, so on main these same images are tagged and pushed rather than built again.
        stage('Build images') {
          steps {
            script { env.TAG = "sha-${env.GIT_COMMIT.take(7)}" }
            sh '''
              V="--build-arg APP_VERSION=$TAG --build-arg GIT_SHA=$GIT_COMMIT"
              docker build $V --build-arg APP=api -t sotto-api:$IMG . & a=$!
              docker build $V --build-arg APP=worker -t sotto-worker:$IMG . & w=$!
              docker build $V -t sotto-transcriber:$IMG services/transcriber & t=$!
              wait $a && wait $w && wait $t
            '''
          }
        }
      }
    }

    // "One command starts everything": the real images on real Postgres, Redis, RabbitMQ and S3
    // answer /readyz, and their own HEALTHCHECKs agree.
    stage('Smoke') {
      steps {
        script { freshServices() }
        sh '''
          docker run --rm --network $NET -e DATABASE_URL=$DB sotto-api:$IMG sh scripts/migrate.sh
          docker run -d --name $CI_NAME-api --network $NET -p $API_PORT:4000 $S3_ENV \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 -e RABBITMQ_URL=$MQ \
            -e AUTH_SECRET="$(openssl rand -hex 32)" -e APP_URL=http://localhost:$API_PORT sotto-api:$IMG
          docker run -d --name $CI_NAME-worker --network $NET -p $WORKER_PORT:4100 -e RABBITMQ_URL=$MQ \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 -e AI_EMBEDDINGS=fake:fake-hash sotto-worker:$IMG
          docker run -d --name $CI_NAME-transcriber --network $NET -p $TRANS_PORT:5000 -e RABBITMQ_URL=$MQ \
            -e TRANSCRIBER_ENGINE=fake sotto-transcriber:$IMG
          for i in $(seq 1 45); do
            if curl -fsS localhost:$API_PORT/readyz && curl -fsS localhost:$WORKER_PORT/readyz && curl -fsS localhost:$TRANS_PORT/readyz; then
              for c in $CI_NAME-api $CI_NAME-worker $CI_NAME-transcriber; do
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
          mkdir -p "$PWD/.ci"
          docker run --rm -v "$PWD/.ci:/out" -e HOST_IDS="$(id -u):$(id -g)" debian:bookworm-slim sh -c '
            apt-get update -qq && apt-get install -y -qq ffmpeg espeak-ng >/dev/null
            espeak-ng -s 130 -w /tmp/s1.wav "Good morning everyone. This is the design review for the Lagos launch."
            espeak-ng -s 130 -w /tmp/s2.wav "Next item. The budget for the second quarter is approved."
            espeak-ng -s 130 -w /tmp/s3.wav "Last point. We ship the recorder on Friday."
            ffmpeg -loglevel error -y -f lavfi -t 1800 -i anullsrc=r=16000:cl=mono \
              -i /tmp/s1.wav -i /tmp/s2.wav -i /tmp/s3.wav -filter_complex \
              "[1]aresample=16000,adelay=3000[a];[2]aresample=16000,adelay=1230000[b];[3]aresample=16000,adelay=1770000[c];[0][a][b][c]amix=inputs=4:duration=first:normalize=0" \
              -ac 1 -c:a libopus -b:a 32k /out/sotto-ci-meeting.ogg
            chown $HOST_IDS /out/sotto-ci-meeting.ogg'
          docker run --rm --network $NET -e DATABASE_URL=$DB sotto-api:$IMG sh scripts/migrate.sh
          docker run -d --name $CI_NAME-api --network $NET -p $API_PORT:4000 $S3_ENV \
            -e S3_PUBLIC_ENDPOINT=http://localhost:$S3_PORT -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 \
            -e RABBITMQ_URL=$MQ -e AUTH_SECRET="$(openssl rand -hex 32)" -e APP_URL=http://localhost:$API_PORT \
            -e SMTP_URL=smtp://mailpit:1025 -e AUTH_RATE_LIMIT=off sotto-api:$IMG
          docker run -d --name $CI_NAME-worker --network $NET -p $WORKER_PORT:4100 $S3_ENV -e RABBITMQ_URL=$MQ \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 -e AI_EMBEDDINGS=fake:fake-hash sotto-worker:$IMG
          docker run -d --name $CI_NAME-transcriber --network $NET -p $TRANS_PORT:5000 $S3_ENV -e RABBITMQ_URL=$MQ \
            -e TRANSCRIBER_ENGINE=faster-whisper -e WHISPER_MODEL=tiny -v "$CACHE/whisper:/models" \
            sotto-transcriber:$IMG
          for i in $(seq 1 90); do
            curl -fsS localhost:$API_PORT/readyz >/dev/null && curl -fsS localhost:$WORKER_PORT/readyz >/dev/null \
              && curl -fsS localhost:$TRANS_PORT/readyz >/dev/null && break
            sleep 2
          done
          API_URL=http://localhost:$API_PORT MAILPIT_URL=http://localhost:$MAILPIT_PORT \
            MEETING_FILE=$PWD/.ci/sotto-ci-meeting.ogg node scripts/ingestion-check.ts
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
          for i in $(seq 1 60); do curl -fsS localhost:$OLLAMA_PORT/api/version >/dev/null && break; sleep 1; done
          curl -fsS localhost:$OLLAMA_PORT/api/pull -d '{"model":"nomic-embed-text"}' | tail -1
          curl -fsS localhost:$OLLAMA_PORT/api/embed -d '{"model":"nomic-embed-text","input":"ready"}' | head -c 80; echo
          AI="-e AI_EMBEDDINGS=ollama:nomic-embed-text -e OLLAMA_URL=http://ollama:11434"
          docker run --rm --network $NET -e DATABASE_URL=$DB sotto-api:$IMG sh scripts/migrate.sh
          docker run -d --name $CI_NAME-api --network $NET -p $API_PORT:4000 $S3_ENV $AI \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 -e RABBITMQ_URL=$MQ \
            -e AUTH_SECRET="$(openssl rand -hex 32)" -e APP_URL=http://localhost:$API_PORT \
            -e SMTP_URL=smtp://mailpit:1025 -e AUTH_RATE_LIMIT=off -e ASK_RATE_PER_MINUTE=1000 sotto-api:$IMG
          docker run -d --name $CI_NAME-worker --network $NET -p $WORKER_PORT:4100 $S3_ENV $AI -e RABBITMQ_URL=$MQ \
            -e DATABASE_URL=$DB -e REDIS_URL=redis://redis:6379 sotto-worker:$IMG
          for i in $(seq 1 90); do
            curl -fsS localhost:$API_PORT/readyz >/dev/null && curl -fsS localhost:$WORKER_PORT/readyz >/dev/null && break
            sleep 2
          done
          API_URL=http://localhost:$API_PORT MAILPIT_URL=http://localhost:$MAILPIT_PORT node scripts/eval.ts
          OLLAMA_URL=http://localhost:$OLLAMA_PORT node scripts/eval-similarity.ts || true
        '''
      }
      post { failure { script { serviceLogs() } } }
    }

    stage('Push images') {
      when {
        branch 'main'
        expression { demoIsUp() }
      }
      steps {
        sh '''
          ECR_REGISTRY="${ECR_REGISTRY:-$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$AWS_REGION.amazonaws.com}"
          aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_REGISTRY
          for svc in api worker transcriber; do
            ARCH=$(docker image inspect -f '{{.Architecture}}' sotto-$svc:$IMG)
            [ "$ARCH" = arm64 ] || { echo "sotto-$svc:$IMG is $ARCH; the demo needs arm64"; exit 1; }
          done
          for svc in api worker transcriber; do
            for t in $TAG main; do
              docker tag sotto-$svc:$IMG $ECR_REGISTRY/sotto/$svc:$t
              docker push --quiet $ECR_REGISTRY/sotto/$svc:$t
            done
          done
        '''
      }
    }

    stage('Deploy to demo') {
      when {
        branch 'main'
        expression { demoIsUp() }
      }
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
      // Only this build's slot; nothing to clean if it never got one.
      sh '''
        [ -n "$CI_NAME" ] || exit 0
        docker rm -f $CI_NAME-api $CI_NAME-worker $CI_NAME-transcriber >/dev/null 2>&1 || true
        # The Ollama model volume is kept (it's a 275 MB download); everything else goes.
        docker compose -f compose.deps.yaml --profile ai down >/dev/null 2>&1 || true
        docker volume rm ${CI_NAME}_pgdata ${CI_NAME}_s3data >/dev/null 2>&1 || true
      '''
      cleanWs()
    }
  }
}
