pipeline {
  agent any

  options {
    timeout(time: 45, unit: 'MINUTES')
    disableConcurrentBuilds()
  }

  environment {
    AWS_REGION = 'eu-west-2'
    COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    COMPOSE_PROJECT_NAME = 'sotto-ci'
    TEST_DATABASE_URL = 'postgresql://sotto:sotto@localhost:5432/postgres'
    TEST_S3_ENDPOINT = 'http://localhost:8333'
    REQUIRE_INTEGRATION = '1'
  }

  stages {
    stage('Start test databases') {
      steps {
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

    stage('Build and push images') {
      when { branch 'main' }
      steps {
        script { env.TAG = "sha-${env.GIT_COMMIT.take(7)}" }
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
      sh 'docker compose -f compose.deps.yaml down -v || true'
      cleanWs()
    }
  }
}
