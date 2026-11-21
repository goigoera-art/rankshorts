@echo off
rem Publishes the site (folder "public") to the gh-pages branch, which GitHub Pages serves.
cd /d "%~dp0"
git subtree split --prefix public -b gh-pages-tmp || goto :err
git push --force origin gh-pages-tmp:gh-pages || goto :err
git branch -D gh-pages-tmp
echo Done. The site updates in about a minute.
goto :eof
:err
echo Publishing failed.
exit /b 1
