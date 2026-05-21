#!/bin/bash
# ============================================
# AI Trading Agent - GitHub + Railway 원클릭 배포 스크립트
# ============================================
# 사용법:
#   chmod +x setup-and-deploy.sh
#   ./setup-and-deploy.sh
# ============================================

set -e

echo "================================================"
echo "  AI Trading Agent v1 - 배포 자동화"
echo "================================================"
echo ""

# GitHub Personal Access Token 입력
if [ -z "$GITHUB_TOKEN" ]; then
  echo "📋 GitHub Personal Access Token이 필요합니다."
  echo ""
  echo "토큰 생성 방법:"
  echo "  1. https://github.com/settings/tokens 접속"
  echo "  2. Generate new token (classic) 클릭"
  echo "  3. 권한 체크: repo, workflow"
  echo "  4. 토큰 복사"
  echo ""
  read -p "GitHub Token 입력: " GITHUB_TOKEN
  export GITHUB_TOKEN
fi

# GitHub 사용자명
GITHUB_USER="renee1004"
REPO_NAME="trading_agent_v1"

echo ""
echo "🔍 GitHub 인증 확인..."
gh auth status 2>/dev/null || {
  echo "$GITHUB_TOKEN" | gh auth login --with-token
  echo "✅ GitHub 인증 완료"
}

# 저장소 생성
echo ""
echo "📦 GitHub 저장소 생성 중..."
if gh repo view "$GITHUB_USER/$REPO_NAME" 2>/dev/null; then
  echo "✅ 저장소가 이미 존재합니다: https://github.com/$GITHUB_USER/$REPO_NAME"
else
  gh repo create "$REPO_NAME" --private --description "한국투자증권 AI 자동매매 에이전트"
  echo "✅ 저장소 생성 완료: https://github.com/$GITHUB_USER/$REPO_NAME"
fi

# Git remote 설정
echo ""
echo "🔗 Git remote 설정 중..."
cd "$(dirname "$0")"

if git remote get-url origin 2>/dev/null; then
  git remote set-url origin "https://$GITHUB_USER:$GITHUB_TOKEN@github.com/$GITHUB_USER/$REPO_NAME.git"
else
  git remote add origin "https://$GITHUB_USER:$GITHUB_TOKEN@github.com/$GITHUB_USER/$REPO_NAME.git"
fi
echo "✅ Remote 설정 완료"

# 코드 푸시
echo ""
echo "🚀 GitHub에 코드 푸시 중..."
git push -u origin main
echo "✅ 코드 푸시 완료"

# Railway 배포 안내
echo ""
echo "================================================"
echo "  🎉 GitHub 푸시 완료!"
echo "================================================"
echo ""
echo "다음 단계: Railway 배포"
echo ""
echo "1. https://railway.app 접속 → GitHub로 로그인"
echo "2. New Project → Deploy from GitHub repo"
echo "3. $GITHUB_USER/$REPO_NAME 선택"
echo "4. New → Database → PostgreSQL 추가"
echo "5. 웹 서비스 Variables 탭에서 환경변수 설정:"
echo "   - DATABASE_URL: (PostgreSQL 추가 시 자동 설정)"
echo "   - KIS_APP_KEY: (한국투자증권 모의투자 App Key)"
echo "   - KIS_APP_SECRET: (한국투자증권 모의투자 App Secret)"
echo "   - KIS_ACCOUNT_NO: (모의투자 계좌번호)"
echo "   - KIS_IS_DEMO: true"
echo "6. 배포 완료 후 제공되는 URL로 대시보드 접속"
echo ""
echo "또는 Railway CLI로 배포:"
echo "  npm i -g @railway/cli"
echo "  railway login"
echo "  railway init (프로젝트 연결)"
echo "  railway up (배포)"
echo ""
echo "================================================"
