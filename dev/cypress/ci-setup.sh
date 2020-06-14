case $TEST_MATRIX in
postgres)
  echo "Using PostgreSQL..."
  docker run -d -p 5432:5432 --name db --network="host" -e "POSTGRES_PASSWORD=Password123!" -e "POSTGRES_USER=wiki" -e "POSTGRES_DB=wiki" postgres:11
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=postgres" -e "DB_HOST=localhost" -e "DB_PORT=5432" -e "DB_NAME=wiki" -e "DB_USER=wiki" -e "DB_PASS=Password123!" requarks/wiki:canary-$BUILD_BUILDNUMBER
  ;;
mysql)
  echo "Using MySQL..."
  docker run -d -p 3306:3306 --name db --network="host" -e "MYSQL_ROOT_PASSWORD=Password123!" -e "MYSQL_USER=wiki" -e "MYSQL_PASSWORD=Password123!" -e "MYSQL_DATABASE=wiki" mysql:8
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=mysql" -e "DB_HOST=localhost" -e "DB_PORT=3306" -e "DB_NAME=wiki" -e "DB_USER=wiki" -e "DB_PASS=Password123!" requarks/wiki:canary-$BUILD_BUILDNUMBER
  ;;
mariadb)
  echo "Using MariaDB..."
  docker run -d -p 3306:3306 --name db --network="host" -e "MYSQL_ROOT_PASSWORD=Password123!" -e "MYSQL_USER=wiki" -e "MYSQL_PASSWORD=Password123!" -e "MYSQL_DATABASE=wiki" mariadb:10
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=mariadb" -e "DB_HOST=localhost" -e "DB_PORT=3306" -e "DB_NAME=wiki" -e "DB_USER=wiki" -e "DB_PASS=Password123!" requarks/wiki:canary-$BUILD_BUILDNUMBER
  ;;
mssql)
  echo "Using MS SQL Server..."
  docker run -d -p 1433:1433 --name db --network="host" -e "SA_PASSWORD=Password123!" -e "ACCEPT_EULA=wiki" -e "MYSQL_PASSWORD=Password123!" -e "MYSQL_DATABASE=wiki" mcr.microsoft.com/mssql/server:2019-latest
  sleep 30
  docker exec db /opt/mssql-tools/bin/sqlcmd -S localhost -U SA -P "Password123!" -Q 'CREATE DATABASE wiki'
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=mssql" -e "DB_HOST=localhost" -e "DB_PORT=1433" -e "DB_NAME=wiki" -e "DB_USER=SA" -e "DB_PASS=Password123!" requarks/wiki:canary-$BUILD_BUILDNUMBER
  ;;
sqlite)
  echo "Using SQLite..."
  docker run -d -p 3000:3000 --name wiki --network="host" -e "DB_TYPE=sqlite" -e "DB_FILEPATH=db.sqlite" requarks/wiki:canary-$BUILD_BUILDNUMBER
  ;;
*)
  echo "Invalid DB Type!"
  ;;
esac
