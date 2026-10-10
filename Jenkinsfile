// Jenkins CI/CD for sotto-api (ADR 0023 in sotto-platform; setup guide linked there).
// Runs on the sotto-jenkins EC2 server, which has Node 24 (pnpm via Corepack), Docker with Buildx
// and Compose, and the AWS CLI configured for the jenkins user.
//   Every branch and PR: test databases, install, build, lint, format, typecheck, tests.
//   main only: build arm64 images (api, worker, transcriber), push to ECR, deploy the demo.
// Heavy checks (transcriber pytest, smoke, ingestion, evals, secret scan) stay in GitHub
// Actions' ci.yml. ECR_REGISTRY is a Jenkins global environment variable.

pipeline {
  agent any

  options {
    timeout(time: 45, unit: 'MINUTES')
    // One build per branch at a time; the server also runs a single executor, because the
    // test databases bind fixed ports and every deploy targets the same demo server.
    disableConcurrentBuilds()
  }

  environment {
    AWS_REGION = 'eu-west-2'
    COREPACK_ENABLE_DOWNLOAD_PROMPT = '0' // let Corepack fetch the pinned pnpm without asking
    COMPOSE_PROJECT_NAME = 'sotto-ci'
    // Same values as ci.yml's integration job.
    TEST_DATABASE_URL = 'postgresql://sotto:sotto@localhost:5432/postgres'
    TEST_S3_ENDPOINT = 'http://localhost:8333'
    REQUIRE_INTEGRATION = '1'
  }

  stages {
    stage('Start test databases') {
      steps {
        // Postgres (pgvector), Redis and SeaweedFS as S3, from the repo's own compose file.
        sh '''
          docker compose -f compose.deps.yaml up -d --wait postgres redis s3
          sleep 5
          curl -s -o /dev/null -X PUT http://localhost:8333/sotto-test
        '''
      }
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

    stage('OpenAPI up to date') {
      steps {
        sh '''
          pnpm openapi
          git diff --exit-code openapi.json
        '''
      }
    }

    stage('Build and push images') {
      when { branch 'main' }
      steps {
        script { env.TAG = "sha-${env.GIT_COMMIT.take(7)}" }
        // arm64 because the demo server is a Graviton t4g; the Jenkins server is ARM too, so
        // no emulation. Same tags as images.yml: sha-<7> plus a moving main.
        sh '''
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
        // The demo has no SSH port: deploys run its deploy.sh through the sotto-deploy SSM
        // document, exactly as images.yml did.
        sh '''
          ID=$(aws ssm send-command --document-name sotto-deploy \
            --targets "Key=tag:sotto-role,Values=demo" \
            --parameters "services=api worker transcriber,tag=$TAG" \
            --comment "sotto-api $TAG (jenkins)" \
            --query Command.CommandId --output text)
          echo "Deploy command: $ID"
          for i in $(seq 1 60); do
            STATUS=$(aws ssm list-commands --command-id $ID --query 'Commands[0].Status' --output text)
            echo "status: $STATUS"
            [ "$STATUS" = "Success" ] && exit 0
            case "$STATUS" in
              Failed|Cancelled|TimedOut)
                aws ssm list-command-invocations --command-id $ID --details \
                  --query 'CommandInvocations[0].CommandPlugins[0].Output' --output text
                exit 1 ;;
            esac
            sleep 10
          done
          exit 1
        '''
      }
    }
  }

  post {
    always {
      sh 'docker compose -f compose.deps.yaml down -v || true'
      cleanWs()
    }
  }
}
